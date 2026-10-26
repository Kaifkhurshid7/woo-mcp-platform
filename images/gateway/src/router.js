import crypto from 'node:crypto';
import { classifyError } from './upstream.js';

const MAX_TOOL_NAME = 64; // the limit most MCP clients / LLM APIs enforce

/**
 * Naming scheme (documented in docs/ARCHITECTURE.md): every tool is exposed as
 *   <server-slug>__<tool-name>
 * Slugs are unique and cannot contain "_", so two upstreams that both define `ping` surface as
 * `notes__ping` and `utils__ping` and collisions are impossible by construction. Names longer
 * than 64 chars are shortened deterministically with a hash suffix.
 */
export function exposedName(slug, tool) {
  const clean = String(tool).replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `${slug}__${clean}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const h = crypto.createHash('sha1').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${h}`;
}

const globToRegex = (g) => new RegExp(`^${g.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

export function matchesAny(patternList, name) {
  return String(patternList || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => globToRegex(p).test(name));
}

const SENSITIVE = /pass(word)?|secret|token|authorization|api[-_]?key|credential/i;
function redact(value, depth = 0) {
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  return value;
}

const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text: `[gateway] ${text}` }] });

export function createRouter({ db, upstreams, metrics, cfg }) {
  const hits = new Map(); // userId -> timestamps (ms) of recent calls (per replica)

  function rateLimited(userId) {
    if (!cfg.rateLimitPerMin) return false;
    const now = Date.now();
    const arr = (hits.get(userId) || []).filter((t) => now - t < 60_000);
    if (arr.length >= cfg.rateLimitPerMin) {
      hits.set(userId, arr);
      return true;
    }
    arr.push(now);
    hits.set(userId, arr);
    return false;
  }

  function audit({ user, source, serverSlug, tool, durationMs, outcome, error, args }) {
    try {
      db.prepare('INSERT INTO audit (ts, user_id, user_email, source, server_slug, tool, duration_ms, outcome, error, args) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        Date.now(),
        user?.id ?? null,
        user?.email ?? null,
        source,
        serverSlug ?? null,
        tool ?? null,
        durationMs ?? null,
        outcome,
        error ? String(error).slice(0, 500) : null,
        args === undefined ? null : JSON.stringify(redact(args)).slice(0, 600),
      );
    } catch (e) {
      console.error('[audit] failed to write', e);
    }
    metrics.inc('gateway_tool_calls_total', 'Tool calls handled by the gateway', { server: serverSlug || 'none', outcome, source });
    if (durationMs !== undefined && serverSlug) {
      metrics.observe('gateway_tool_call_duration_seconds', 'Tool call latency as seen by the gateway', { server: serverSlug }, durationMs / 1000);
    }
  }

  /** Tools visible to this user: connected + enabled servers only, minus admin-only tools for members. */
  function exposedTools(user) {
    const out = [];
    for (const server of upstreams.rows()) {
      if (!server.enabled || upstreams.statusOf(server) !== 'connected') continue;
      for (const tool of upstreams.toolsOf(server)) {
        if (user.role !== 'admin' && matchesAny(server.admin_only_tools, tool.name)) continue;
        out.push({
          name: exposedName(server.slug, tool.name),
          title: tool.title,
          description: `[${server.name}] ${tool.description || tool.title || tool.name}`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
          server,
          upstreamName: tool.name,
        });
      }
    }
    return out;
  }

  /** What goes on the wire for tools/list (no internal fields). */
  const toWire = (t) => {
    const { server, upstreamName, ...wire } = t;
    return Object.fromEntries(Object.entries(wire).filter(([, v]) => v !== undefined));
  };

  async function callTool(user, name, rawArgs, { source = 'mcp' } = {}) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const started = Date.now();
    const done = (fields) => audit({ user, source, args, durationMs: Date.now() - started, ...fields });

    if (rateLimited(user.id)) {
      done({ tool: name, outcome: 'rate_limited', error: `limit ${cfg.rateLimitPerMin}/min` });
      return errorResult(`Rate limit exceeded (${cfg.rateLimitPerMin} tool calls per minute). Try again shortly.`);
    }

    const target = exposedTools(user).find((t) => t.name === name);
    if (!target) {
      done({ tool: name, outcome: 'rejected', error: 'unknown or unavailable tool' });
      return errorResult(`Unknown or unavailable tool "${name}". It may belong to a disabled or unreachable server, or you may not be allowed to use it.`);
    }

    try {
      const result = await upstreams.callTool(target.server, target.upstreamName, args);
      const failed = result?.isError === true;
      done({ serverSlug: target.server.slug, tool: target.upstreamName, outcome: failed ? 'error' : 'success', error: failed ? firstText(result) : undefined });
      return result && Array.isArray(result.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (e) {
      const err = classifyError(e);
      const outcome = err.kind === 'timeout' ? 'timeout' : err.kind === 'unreachable' ? 'unreachable' : 'error';
      if (err.kind === 'unreachable' || err.kind === 'auth') upstreams.markFailed(target.server.id, err);
      done({ serverSlug: target.server.slug, tool: target.upstreamName, outcome, error: `${err.kind}: ${err.message}` });
      const friendly =
        err.kind === 'timeout'
          ? `Server "${target.server.slug}" did not answer in time (${err.message}). Other servers are unaffected.`
          : `Server "${target.server.slug}" failed: ${err.message}. Other servers are unaffected.`;
      return errorResult(friendly);
    }
  }

  return { exposedTools, toWire, callTool, audit };
}

function firstText(result) {
  const t = result?.content?.find?.((c) => c.type === 'text');
  return t?.text?.slice(0, 300) || 'tool returned an error';
}
