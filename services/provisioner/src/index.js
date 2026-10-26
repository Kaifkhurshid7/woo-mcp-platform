/**
 * Provisioner entry point: a small internal HTTP API (called only by the gateway) plus the reconcile loop.
 *
 *   GET    /stores             list (admins: all, members: their own)
 *   POST   /stores             create {name}      (Idempotency-Key header makes retries safe)
 *   POST   /stores/:id/retry   re-run a Failed store
 *   DELETE /stores/:id         delete (owner or admin)
 *   GET|POST|DELETE /hosted    hosted MCP servers from container images (admin only)
 *
 * Every request must carry the shared internal token; the caller's identity arrives in X-User-* headers.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createK8s } from './k8s.js';
import { runHelm } from './helm.js';
import { createGatewayClient } from './gateway.js';
import { ApiError, createManager } from './manager.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 50_000) reject(new ApiError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new ApiError(400, 'Invalid JSON'));
      }
    });
  });

/** Build the HTTP request handler. Exported for tests. */
export function createHandler({ cfg, manager, k8s }) {
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (url.pathname === '/readyz') {
        await k8s.ping();
        return send(200, { ok: true });
      }

      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (!cfg.internalToken || !m || !safeEqual(m[1], cfg.internalToken)) throw new ApiError(401, 'Unauthorized');
      const user = { id: req.headers['x-user-id'], email: req.headers['x-user-email'], role: req.headers['x-user-role'] };
      if (!user.id || !user.email) throw new ApiError(400, 'Missing user identity');
      const idem = req.headers['idempotency-key'];

      const parts = url.pathname.split('/').filter(Boolean); // [kind, id?, action?]
      const [collection, id, action] = parts;
      const kind = collection === 'stores' ? 'store' : collection === 'hosted' ? 'hosted' : null;
      if (!kind) throw new ApiError(404, 'Not found');
      if (kind === 'hosted' && user.role !== 'admin') throw new ApiError(403, 'Admin only');

      if (req.method === 'GET' && !id) return send(200, { [collection]: await manager.list(kind, user) });
      if (req.method === 'POST' && !id) {
        const body = await readJson(req);
        const item = kind === 'store' ? await manager.createStore(user, body, idem) : await manager.createHosted(user, body, idem);
        return send(202, { [kind]: item });
      }
      if (req.method === 'POST' && id && action === 'retry') return send(202, { [kind]: await manager.retry(kind, user, id) });
      if (req.method === 'DELETE' && id && !action) return send(202, { [kind]: await manager.remove(kind, user, id) });
      throw new ApiError(404, 'Not found');
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      console.error('[api] error', e);
      send(500, { error: 'Internal error' });
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (!cfg.internalToken || !cfg.gatewayUrl) throw new Error('INTERNAL_TOKEN and GATEWAY_URL are required');
  const k8s = createK8s();
  const manager = createManager({ cfg, k8s, runHelm, gateway: createGatewayClient(cfg) });
  const server = http.createServer(createHandler({ cfg, manager, k8s }));
  server.listen(cfg.port, () => console.log(`[provisioner] listening on :${cfg.port}, platform namespace ${cfg.platformNamespace}`));

  const tick = () => manager.reconcile().catch((e) => console.error('[reconcile] failed', e.message));
  tick(); // resume or fail whatever was in flight when the previous instance stopped
  const timer = setInterval(tick, cfg.reconcileIntervalMs);
  const shutdown = () => {
    clearInterval(timer);
    for (const ac of manager.jobs.values()) ac.abort('shutdown'); // namespaces stay Provisioning; the next start resumes them
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
