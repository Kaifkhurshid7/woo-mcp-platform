/**
 * The tool router: decides which tools a user may see, enforces rate limits and permissions,
 * forwards calls to the right upstream and writes one audit record per call.
 */
import crypto from 'node:crypto';
import { classifyError } from './upstream.js';

const MAX_TOOL_NAME = 64; // the limit most MCP clients / LLM APIs enforce

/**
 * Naming scheme (documented in docs/ARCHITECTURE.md): every tool is exposed as
 *   <server-slug>__<tool-name>
 * Slugs are unique and cannot contain "_", so two upstreams that both define `ping` surface as
 * `notes__ping` and `utils__ping` and collisions are impossible by construction. Names longer
 * than 64 chars are shortened deterministically with a hash suffix.
 *
 * @param {string} slug upstream server slug
 * @param {string} tool the upstream's own tool name
 */
export function exposedName(slug, tool) {
  const clean = String(tool).replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `${slug}__${clean}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const h = crypto.createHash('sha1').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${h}`;
}

const globToRegex = (g) =>
  new RegExp(
    `^${g
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
    'i',
  );

/** True if `name` matches any pattern in a comma-separated glob list (e.g. "create_*, update_order_status"). */
export function matchesAny(patternList, name) {
  return String(patternList || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => globToRegex(p).test(name));
}

const SENSITIVE = /pass(word)?|secret|token|authorization|api[-_]?key|credential/i;

/** Copy of the tool arguments that is safe to store in the audit log (secrets masked, long values cut). */
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

function firstText(result) {
  const t = result?.content?.find?.((c) => c.type === 'text');
  return t?.text?.slice(0, 300) || 'tool returned an error';
}

/**
 * "Many tools" mode: instead of listing hundreds of tools, the gateway can expose three meta-tools that
 * let a model search the catalogue and then call what it found. Permissions, rate limits and audit all
 * still go through callTool(), so nothing is bypassed.
 */
const META_TOOLS = [
  {
    name: 'search_tools',
    description:
      'Search the catalogue of every tool available through this gateway. Returns the best matches (name, server, short description). Use describe_tool for the input schema, then call_tool to run one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, e.g. "list orders" or "create product".' },
        server: { type: 'string', description: 'Optional: only search this server (its slug, e.g. woo).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'describe_tool',
    description: 'Return the full description and JSON input schema of one tool, using the name returned by search_tools.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'call_tool',
    description: 'Run a tool found with search_tools. Pass its exact name and an arguments object that matches its input schema.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
  },
];

const tokenize = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

export function createRouter({ db, upstreams, metrics, cfg }) {
  /**
   * Per-user sliding-window rate limit. The window is counted from the shared audit table, so the
   * limit holds across all gateway replicas (a per-process counter would multiply it by the replica count).
   */
  async function rateLimited(userId) {
    if (!cfg.rateLimitPerMin) return false;
    const row = await db.get(
      "SELECT COUNT(*) AS n FROM audit WHERE user_id = ? AND ts > ? AND tool IS NOT NULL AND outcome != 'rate_limited'",
      [userId, Date.now() - 60_000],
    );
    return row.n >= cfg.rateLimitPerMin;
  }

  /** Write one audit record and update the Prometheus counters. Never throws. */
  async function audit({ user, source, serverSlug, tool, durationMs, outcome, error, args }) {
    try {
      await db.run(
        'INSERT INTO audit (ts, user_id, user_email, source, server_slug, tool, duration_ms, outcome, error, args) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
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
        ],
      );
    } catch (e) {
      console.error('[audit] failed to write', e);
    }
    metrics.inc('gateway_tool_calls_total', 'Tool calls handled by the gateway', { server: serverSlug || 'none', outcome, source });
    if (durationMs !== undefined && serverSlug) {
      metrics.observe(
        'gateway_tool_call_duration_seconds',
        'Tool call latency as seen by the gateway',
        { server: serverSlug },
        durationMs / 1000,
      );
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
    const { server: _server, upstreamName: _upstreamName, ...wire } = t;
    return Object.fromEntries(Object.entries(wire).filter(([, v]) => v !== undefined));
  };

  /**
   * Run one tool call as `user`. Always resolves with an MCP tool result (errors become `isError` results
   * with a clear message) so one failing upstream never breaks the caller's session.
   */
  async function callTool(user, name, rawArgs, { source = 'mcp' } = {}) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const started = Date.now();
    const done = (fields) => audit({ user, source, args, durationMs: Date.now() - started, ...fields });

    await upstreams.ensureFresh();
    if (await rateLimited(user.id)) {
      await done({ tool: name, outcome: 'rate_limited', error: `limit ${cfg.rateLimitPerMin}/min` });
      return errorResult(`Rate limit exceeded (${cfg.rateLimitPerMin} tool calls per minute). Try again shortly.`);
    }

    const target = exposedTools(user).find((t) => t.name === name);
    if (!target) {
      await done({ tool: name, outcome: 'rejected', error: 'unknown or unavailable tool' });
      return errorResult(
        `Unknown or unavailable tool "${name}". It may belong to a disabled or unreachable server, or you may not be allowed to use it.`,
      );
    }

    try {
      const result = await upstreams.callTool(target.server, target.upstreamName, args);
      const failed = result?.isError === true;
      await done({
        serverSlug: target.server.slug,
        tool: target.upstreamName,
        outcome: failed ? 'error' : 'success',
        error: failed ? firstText(result) : undefined,
      });
      return result && Array.isArray(result.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (e) {
      const err = classifyError(e);
      const outcome = err.kind === 'timeout' ? 'timeout' : err.kind === 'unreachable' ? 'unreachable' : 'error';
      if (err.kind === 'unreachable' || err.kind === 'auth') upstreams.markFailed(target.server.id, err);
      await done({ serverSlug: target.server.slug, tool: target.upstreamName, outcome, error: `${err.kind}: ${err.message}` });
      const friendly =
        err.kind === 'timeout'
          ? `Server "${target.server.slug}" did not answer in time (${err.message}). Other servers are unaffected.`
          : `Server "${target.server.slug}" failed: ${err.message}. Other servers are unaffected.`;
      return errorResult(friendly);
    }
  }

  /** Rank the user's visible tools against a free-text query (name hits weigh most, then server, then description). */
  function searchTools(user, query, { server, limit = 8 } = {}) {
    const words = tokenize(query);
    const scored = [];
    for (const t of exposedTools(user)) {
      if (server && t.server.slug !== server) continue;
      const name = tokenize(t.upstreamName);
      const desc = tokenize(t.description);
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 4;
        else if (name.some((n) => n.includes(w) || w.includes(n))) score += 2;
        if (t.server.slug === w) score += 2;
        if (desc.includes(w)) score += 1;
      }
      if (score > 0 || !words.length) scored.push({ t, score });
    }
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    return scored
      .slice(0, Math.min(Math.max(limit, 1), 25))
      .map(({ t }) => ({ name: t.name, server: t.server.slug, description: String(t.description).slice(0, 160) }));
  }

  /** Handle a call to one of the meta-tools; returns an MCP tool result. */
  async function callMetaTool(user, name, args, { source = 'mcp' } = {}) {
    const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
    await upstreams.ensureFresh();
    if (name === 'search_tools') {
      return text({
        total: exposedTools(user).length,
        results: searchTools(user, args?.query, { server: args?.server, limit: Number(args?.limit) || 8 }),
      });
    }
    if (name === 'describe_tool') {
      const t = exposedTools(user).find((x) => x.name === args?.name);
      return t
        ? text({ name: t.name, server: t.server.slug, description: t.description, inputSchema: t.inputSchema })
        : errorResult(`Unknown tool "${args?.name}". Use search_tools to find the exact name.`);
    }
    if (name === 'call_tool') {
      if (!args?.name) return errorResult('call_tool needs a "name".');
      return callTool(user, String(args.name), args.arguments ?? {}, { source });
    }
    return errorResult(`Unknown meta-tool "${name}".`);
  }

  return { exposedTools, toWire, callTool, audit, searchTools, callMetaTool, META_TOOLS };
}
