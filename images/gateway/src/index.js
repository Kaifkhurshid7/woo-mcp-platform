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
import { mountApi } from './api.js';
import { createLlm } from './llm/index.js';
import { createChat } from './chat.js';
import { bootstrapAdmin, seedServers } from './seed.js';

export function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const vault = createVault(cfg.encryptionKey);
  const metrics = createMetrics();
  const upstreams = createUpstreams({ db, vault, cfg, metrics });
  const router = createRouter({ db, upstreams, metrics, cfg });
  const auth = createAuth({ db, cfg, audit: router.audit });
  const llm = createLlm(cfg.llm);
  const chat = createChat({ cfg, router, llm });

  bootstrapAdmin(db, cfg);
  seedServers(db, cfg, vault);

  metrics.gauge('gateway_upstream_up', '1 if the upstream answered its last health check', () =>
    upstreams.rows().map((r) => ({ labels: { server: r.slug }, value: upstreams.statusOf(r) === 'connected' ? 1 : 0 })),
  );
  metrics.gauge('gateway_upstream_tools', 'Number of tools an upstream currently exposes', () =>
    upstreams.rows().map((r) => ({ labels: { server: r.slug }, value: upstreams.statusOf(r) === 'connected' ? upstreams.toolsOf(r).length : 0 })),
  );

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });
  app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metrics.render()));

  mountMcp(app, { auth, router });
  mountApi(app, { db, cfg, vault, auth, upstreams, router, llm, chat });

  // JSON body parse errors etc.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http] error', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return { app, db, upstreams, router, close: () => upstreams.stop() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const { app, upstreams, db } = createApp(cfg);
  upstreams.start();
  const server = app.listen(cfg.port, () => console.log(`[gateway] listening on :${cfg.port} (db ${cfg.dbPath}, llm ${cfg.llm.provider})`));
  const shutdown = () => {
    upstreams.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
