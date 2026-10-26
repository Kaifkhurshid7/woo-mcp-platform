/**
 * MCP gateway entry point.
 *
 * One process serves: the dashboard REST API (/api), the MCP endpoints (/mcp, /mcp/search), the OAuth
 * authorization server (/oauth, /.well-known), probes (/healthz, /readyz), Prometheus metrics (/metrics)
 * and the in-cluster-only internal API for the provisioner (/internal).
 */
import { pathToFileURL } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createVault } from './crypto.js';
import { createMetrics } from './metrics.js';
import { createUpstreams } from './upstream.js';
import { createRouter } from './router.js';
import { createAuth } from './auth.js';
import { mountMcp } from './mcp.js';
import { mountOAuth } from './oauth.js';
import { mountApi } from './api/index.js';
import { createLlm } from './llm/index.js';
import { createChat } from './chat.js';
import { createProvisionerClient, mountInternalApi } from './provisioner.js';
import { bootstrapAdmin, seedServers } from './seed.js';

/**
 * Build the application (does not start listening or polling upstreams).
 * @param {import('./config.js').GatewayConfig} cfg
 */
export async function createApp(cfg) {
  const db = await openDb(cfg);
  const vault = createVault(cfg.encryptionKey);
  const metrics = createMetrics();
  const upstreams = createUpstreams({ db, vault, cfg, metrics });
  const router = createRouter({ db, upstreams, metrics, cfg });
  const auth = createAuth({ db, cfg, audit: router.audit });
  const llm = createLlm(cfg.llm);
  const chat = createChat({ cfg, router, llm });
  const provisioner = createProvisionerClient(cfg);

  await bootstrapAdmin(db, cfg);
  await seedServers(db, cfg, vault);
  await upstreams.reload();

  metrics.gauge('gateway_upstream_up', '1 if the upstream answered its last health check', () =>
    upstreams.rows().map((r) => ({ labels: { server: r.slug }, value: upstreams.statusOf(r) === 'connected' ? 1 : 0 })),
  );
  metrics.gauge('gateway_upstream_tools', 'Number of tools an upstream currently exposes', () =>
    upstreams
      .rows()
      .map((r) => ({ labels: { server: r.slug }, value: upstreams.statusOf(r) === 'connected' ? upstreams.toolsOf(r).length : 0 })),
  );

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', true);
  // The OAuth, internal and MCP routers parse their own bodies where needed; the REST API and /mcp use JSON.
  app.use((req, res, next) =>
    req.path.startsWith('/oauth') || req.path.startsWith('/internal') ? next() : express.json({ limit: '2mb' })(req, res, next),
  );

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });
  app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metrics.render()));

  mountOAuth(app, { db, cfg, auth });
  mountMcp(app, { auth, router, upstreams });
  mountInternalApi(app, { db, cfg, vault, upstreams });
  mountApi(app, { db, cfg, vault, auth, upstreams, router, llm, chat, provisioner });

  // JSON body parse errors etc.
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http] error', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return {
    app,
    db,
    upstreams,
    router,
    close: async () => {
      upstreams.stop();
      await db.close();
    },
  };
}

// Run as a server when executed directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const { app, upstreams, db } = await createApp(cfg);
  await upstreams.start();
  const server = app.listen(cfg.port, () =>
    console.log(
      `[gateway] listening on :${cfg.port} (db ${cfg.databaseUrl ? 'postgres' : cfg.dbPath}, llm ${cfg.llm.provider}, oauth ${cfg.oauth.enabled ? 'on' : 'off'})`,
    ),
  );
  const shutdown = () => {
    upstreams.stop();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
