/**
 * Client for the provisioner service (multi-store provisioning and hosted MCP servers) and the
 * gateway's internal registration API that the provisioner calls back.
 *
 * The gateway never touches the Kubernetes API itself: it holds no cluster privileges. All cluster
 * changes go through the provisioner, which authenticates every request with a shared internal token
 * and acts on behalf of the user identified in the X-User-* headers.
 */
import crypto from 'node:crypto';
import express from 'express';
import { uuid } from './crypto.js';
import { assertSafeUpstreamUrl } from './ssrf.js';

/** Thrown when the provisioner is not configured or cannot be reached. */
export class ProvisionerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Timing-safe string comparison. */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * @returns {{enabled: boolean, request: (method: string, path: string, user: object, body?: object, headers?: object) => Promise<object>}}
 */
export function createProvisionerClient(cfg) {
  const enabled = !!cfg.provisionerUrl && !!cfg.internalToken;
  return {
    enabled,
    /** Forward a request to the provisioner on behalf of `user`. Resolves with the parsed JSON body. */
    async request(method, path, user, body, headers = {}) {
      if (!enabled) throw new ProvisionerError(503, 'The provisioner is not enabled in this installation.');
      let res;
      try {
        res = await fetch(`${cfg.provisionerUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.internalToken}`,
            'x-user-id': user.id,
            'x-user-email': user.email,
            'x-user-role': user.role,
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        throw new ProvisionerError(502, `The provisioner is unreachable: ${e.cause?.code || e.message}`);
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProvisionerError(res.status, json.error || `provisioner answered HTTP ${res.status}`);
      return json;
    },
  };
}

/**
 * Internal API used by the provisioner to register/deregister the MCP servers of stores and hosted images.
 * It is NOT exposed through the Ingress; it is reachable only inside the cluster and requires the internal token.
 */
export function mountInternalApi(app, { db, cfg, vault, upstreams }) {
  if (!cfg.internalToken) return;
  const internal = express.Router();
  internal.use(express.json({ limit: '50kb' }));
  internal.use((req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return m && safeEqual(m[1], cfg.internalToken) ? next() : res.status(401).json({ error: 'Unauthorized' });
  });

  /** Create or update the server registered for `ref` (a store id or hosted-server id). */
  internal.put('/servers/:ref', async (req, res, next) => {
    try {
      const { slug, name, url, credential, source, adminOnlyTools } = req.body || {};
      if (!['store', 'hosted'].includes(source) || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(slug || '') || !name || !url) {
        return res.status(400).json({ error: 'slug, name, url and source (store|hosted) are required' });
      }
      await assertSafeUpstreamUrl(url, { allowPrivate: true, allowLoopback: cfg.allowLoopbackUpstreams });
      const credEnc = credential?.token ? vault.encrypt(JSON.stringify({ type: 'bearer', token: credential.token })) : null;
      const now = Date.now();
      const existing = await db.get('SELECT * FROM servers WHERE ref = ?', [req.params.ref]);
      if (existing) {
        await db.run('UPDATE servers SET slug=?, name=?, url=?, cred_enc=?, source=?, updated_at=? WHERE id=?', [
          slug,
          name,
          url,
          credEnc,
          source,
          now,
          existing.id,
        ]);
      } else {
        const clash = await db.get('SELECT 1 AS x FROM servers WHERE slug = ?', [slug]);
        if (clash) return res.status(409).json({ error: `slug "${slug}" is already taken` });
        await db.run(
          'INSERT INTO servers (id, slug, name, url, enabled, cred_enc, admin_only_tools, status, created_at, updated_at, source, ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [uuid(), slug, name, url, 1, credEnc, String(adminOnlyTools || ''), 'unknown', now, now, source, req.params.ref],
        );
      }
      await upstreams.reload();
      const row = await db.get('SELECT id FROM servers WHERE ref = ?', [req.params.ref]);
      if (row) upstreams.refresh(row.id); // don't wait: the dashboard shows "checking" until the first answer
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  internal.delete('/servers/:ref', async (req, res, next) => {
    try {
      const row = await db.get('SELECT id FROM servers WHERE ref = ?', [req.params.ref]);
      if (row) {
        await db.run('DELETE FROM servers WHERE id = ?', [row.id]);
        upstreams.forget(row.id);
        await upstreams.reload();
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Registered refs, so the provisioner can reconcile (remove registrations of stores that no longer exist). */
  internal.get('/servers', async (_req, res, next) => {
    try {
      const rows = await db.all('SELECT ref, slug, source FROM servers WHERE ref IS NOT NULL');
      res.json({ servers: rows });
    } catch (e) {
      next(e);
    }
  });

  app.use('/internal', internal);
}
