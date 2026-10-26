/**
 * REST API for the dashboard (`/api/*`). Authentication is a session cookie; each concern lives in its own module.
 */
import express from 'express';
import { HttpError } from './http.js';
import { mountAuthRoutes } from './authRoutes.js';
import { mountServerRoutes } from './serverRoutes.js';
import { mountUserRoutes } from './userRoutes.js';
import { mountKeyRoutes } from './keyRoutes.js';
import { mountAuditRoutes } from './auditRoutes.js';
import { mountChatRoutes } from './chatRoutes.js';
import { mountPlatformRoutes } from './platformRoutes.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps shared services (db, cfg, vault, auth, upstreams, router, llm, chat, provisioner)
 */
export function mountApi(app, deps) {
  const { auth, cfg, llm } = deps;
  const api = express.Router();

  // CSRF defence in depth: cookies are SameSite=Lax; additionally refuse cross-origin writes.
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        return res.status(403).json({ error: 'Bad origin' });
      }
      if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request refused' });
    }
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    if (hasBody && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
  });

  mountAuthRoutes(api, deps); // public: login, logout, invites

  // Everything below needs a signed-in user.
  api.use(auth.sessionAuth);
  api.get('/auth/me', (req, res) => res.json({ user: req.user }));
  api.get('/config', (req, res) => {
    const base = auth.baseUrl(req);
    res.json({
      mcpUrl: `${base}/mcp`,
      mcpSearchUrl: `${base}/mcp/search`,
      oauth: cfg.oauth.enabled,
      llm: { provider: llm.provider, model: llm.model, configured: llm.configured, reason: llm.reason },
      rateLimitPerMin: cfg.rateLimitPerMin,
      provisioner: !!cfg.provisionerUrl,
      chatMaxDirectTools: cfg.chatMaxDirectTools,
    });
  });

  mountServerRoutes(api, deps);
  mountUserRoutes(api, deps);
  mountKeyRoutes(api, deps);
  mountAuditRoutes(api, deps);
  mountChatRoutes(api, deps);
  mountPlatformRoutes(api, deps);

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  api.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.status === 503) return res.status(503).json({ error: err.message });
    console.error('[api] unhandled error', err);
    res.status(502).json({ error: err?.message ? String(err.message).slice(0, 300) : 'Internal error' });
  });

  app.use('/api', api);
}
