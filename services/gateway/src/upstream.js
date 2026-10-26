/**
 * Connections to the upstream MCP servers: health polling, tool discovery, calls with deadlines, failure classification.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertSafeUpstreamUrl, UnsafeUrlError } from './ssrf.js';

export class UpstreamError extends Error {
  /** kind: timeout | unreachable | auth | blocked | protocol */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const NETWORK_CODES = {
  ECONNREFUSED: 'connection refused (is the pod running?)',
  ENOTFOUND: 'DNS name not found (is the Service gone?)',
  EAI_AGAIN: 'DNS lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ECONNRESET: 'connection reset by peer',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_SOCKET: 'connection closed by peer',
};

/** Turn whatever the SDK/fetch threw into an UpstreamError with an operator-friendly message. */
export function classifyError(e) {
  if (e instanceof UpstreamError) return e;
  if (e instanceof UnsafeUrlError) return new UpstreamError('blocked', `URL blocked: ${e.message}`);
  const httpStatus = typeof e?.code === 'number' ? e.code : undefined;
  if (httpStatus === 401 || httpStatus === 403) {
    return new UpstreamError('auth', `upstream rejected the gateway's credential (HTTP ${httpStatus})`);
  }
  if (httpStatus) return new UpstreamError('unreachable', `upstream answered HTTP ${httpStatus}: ${String(e.message).slice(0, 200)}`);
  const netCode = e?.cause?.code || e?.code;
  if (typeof netCode === 'string' && NETWORK_CODES[netCode]) return new UpstreamError('unreachable', NETWORK_CODES[netCode]);
  if (e?.name === 'AbortError') return new UpstreamError('timeout', 'request aborted');
  return new UpstreamError('protocol', String(e?.message || e).slice(0, 300));
}

/**
 * Manages the gateway's MCP-client connections to every registered upstream.
 *
 * Server rows are cached in memory so the hot paths (tool listing, routing) stay synchronous and fast.
 * The cache is reloaded from the database on every poll and on demand, so with several gateway
 * replicas a change made through one replica reaches the others within a couple of seconds.
 */
export function createUpstreams({ db, vault, cfg, metrics, log = console }) {
  /** id -> { status, error, checkedAt, latencyMs, tools } (in-memory view, persisted on change) */
  const state = new Map();
  const inflight = new Map();
  let cache = [];
  let loadedAt = 0;
  let timer = null;
  let stopped = false;

  const rows = () => cache;
  const row = (id) => cache.find((r) => r.id === id);

  /** Initial in-memory state for a row we have not checked ourselves yet (use what another replica persisted). */
  function adoptPersisted(r) {
    let tools = [];
    try {
      tools = JSON.parse(r.tools_json || '[]');
    } catch {
      /* ignore a corrupt cache */
    }
    const status = !r.enabled ? 'disabled' : r.status === 'connected' || r.status === 'unreachable' ? r.status : 'unknown';
    state.set(r.id, { status, tools, error: r.last_error, checkedAt: r.last_checked_at ?? null, latencyMs: r.latency_ms ?? null });
  }

  /** Reload the server rows from the database. */
  async function reload() {
    cache = await db.all('SELECT * FROM servers ORDER BY created_at, id');
    loadedAt = Date.now();
    const ids = new Set(cache.map((r) => r.id));
    for (const r of cache) if (!state.has(r.id)) adoptPersisted(r);
    for (const id of [...state.keys()]) if (!ids.has(id)) state.delete(id);
  }

  function credentialOf(r) {
    if (!r.cred_enc) return null;
    try {
      return JSON.parse(vault.decrypt(r.cred_enc));
    } catch {
      return null;
    }
  }

  function headersFor(r) {
    const cred = credentialOf(r);
    const headers = {};
    if (cred?.type === 'bearer') headers.Authorization = `Bearer ${cred.token}`;
    else if (cred?.type === 'header') headers[cred.name] = cred.value;
    return headers;
  }

  async function withClient(r, timeoutMs, fn) {
    await assertSafeUpstreamUrl(r.url, { allowPrivate: cfg.allowPrivateUpstreams, allowLoopback: cfg.allowLoopbackUpstreams });
    const ac = new AbortController();
    const transport = new StreamableHTTPClientTransport(new URL(r.url), { requestInit: { headers: headersFor(r) } });
    const client = new Client({ name: 'mcp-gateway', version: '1.0.0' }, { capabilities: {} });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new UpstreamError('timeout', `no answer within ${timeoutMs}ms`);
        ac.abort(err);
        reject(err);
      }, timeoutMs);
    });
    const work = (async () => {
      await client.connect(transport, { signal: ac.signal, timeout: timeoutMs });
      return fn(client, { signal: ac.signal, timeout: timeoutMs });
    })();
    work.catch(() => {}); // avoid unhandled rejection if the deadline wins
    try {
      return await Promise.race([work, deadline]);
    } catch (e) {
      throw classifyError(e);
    } finally {
      clearTimeout(timer);
      Promise.race([client.close(), new Promise((r2) => setTimeout(r2, 500))]).catch(() => {});
    }
  }

  function persist(id, s) {
    db.run('UPDATE servers SET status=?, last_error=?, last_checked_at=?, latency_ms=?, tools_json=? WHERE id=?', [
      s.status,
      s.error ?? null,
      s.checkedAt ?? null,
      s.latencyMs ?? null,
      JSON.stringify(s.tools || []),
      id,
    ]).catch((e) => log.error('[upstream] could not persist status', e.message));
  }

  function setState(r, next) {
    const prev = state.get(r.id);
    state.set(r.id, next);
    persist(r.id, next);
    if (prev?.status !== next.status) {
      log.log(`[upstream] ${r.slug}: ${prev?.status ?? 'new'} -> ${next.status}${next.error ? ` (${next.error})` : ''}`);
    }
  }

  async function listAllTools(client, opts) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, opts);
      tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }));
  }

  async function doRefresh(id) {
    const r = row(id);
    if (!r) return;
    if (!r.enabled) {
      setState(r, { status: 'disabled', tools: [], checkedAt: Date.now() });
      return;
    }
    const started = Date.now();
    try {
      const tools = await withClient(r, cfg.listTimeoutMs, (client, opts) => listAllTools(client, opts));
      setState(r, { status: 'connected', tools, error: null, checkedAt: Date.now(), latencyMs: Date.now() - started });
    } catch (e) {
      const err = classifyError(e);
      const prev = state.get(id);
      setState(r, {
        status: 'unreachable',
        tools: prev?.tools || [],
        error: `${err.kind}: ${err.message}`,
        checkedAt: Date.now(),
        latencyMs: null,
      });
    }
  }

  const api = {
    rows,
    row,
    state,
    credentialOf,
    reload,

    /** Reload the rows if the cache is older than maxAgeMs (bounds staleness across replicas). */
    async ensureFresh(maxAgeMs = 2000) {
      if (Date.now() - loadedAt > maxAgeMs) await reload();
    },

    /** Re-check one server now (deduplicated if a check is already running). */
    refresh(id) {
      if (!inflight.has(id)) {
        inflight.set(
          id,
          doRefresh(id)
            .catch((e) => log.error('[upstream] refresh crashed', e))
            .finally(() => inflight.delete(id)),
        );
      }
      return inflight.get(id);
    },

    refreshAll() {
      return Promise.all(rows().map((r) => api.refresh(r.id)));
    },

    /** Mark a server unreachable right away after a failed call, without waiting for the next poll. */
    markFailed(id, err) {
      const r = row(id);
      if (!r || !r.enabled) return;
      const prev = state.get(id);
      if (prev?.status === 'unreachable') return;
      setState(r, {
        status: 'unreachable',
        tools: prev?.tools || [],
        error: `${err.kind}: ${err.message}`,
        checkedAt: Date.now(),
        latencyMs: null,
      });
    },

    forget(id) {
      state.delete(id);
      inflight.delete(id);
    },

    /** Status as shown to people: disabled wins, otherwise whatever the last check said. */
    statusOf(r) {
      if (!r.enabled) return 'disabled';
      return state.get(r.id)?.status === 'connected' ? 'connected' : state.get(r.id)?.status === 'unreachable' ? 'unreachable' : 'checking';
    },

    toolsOf(r) {
      return state.get(r.id)?.tools || [];
    },

    async callTool(r, tool, args) {
      const started = Date.now();
      const result = await withClient(r, cfg.callTimeoutMs, (client, opts) =>
        client.callTool({ name: tool, arguments: args }, undefined, opts),
      );
      metrics?.observe(
        'gateway_upstream_roundtrip_seconds',
        'Upstream connect+call time',
        { server: r.slug },
        (Date.now() - started) / 1000,
      );
      return result;
    },

    async start() {
      await reload();
      const tick = async () => {
        if (stopped) return;
        try {
          await reload();
          await api.refreshAll();
        } catch (e) {
          log.error('[upstream] poll failed', e.message);
        }
        if (!stopped) timer = setTimeout(tick, cfg.refreshIntervalMs);
      };
      tick();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };

  return api;
}
