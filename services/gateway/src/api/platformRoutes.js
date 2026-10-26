/**
 * Platform routes: multi-store provisioning and hosted MCP servers.
 *
 * These are thin, authenticated proxies to the provisioner service. The provisioner owns the Kubernetes
 * logic and the per-user limits; the gateway only forwards the signed-in user's identity.
 */
import { randomUUID } from 'node:crypto';
import { ProvisionerError } from '../provisioner.js';
import { HttpError, wrap } from './http.js';

export function mountPlatformRoutes(api, { auth, provisioner }) {
  /** Forward to the provisioner and translate its errors into HTTP errors for the dashboard. */
  const forward = (method, buildPath, { adminOnly = false, status = 200 } = {}) => [
    ...(adminOnly ? [auth.requireAdmin] : []),
    wrap(async (req, res) => {
      try {
        const body = method === 'POST' ? req.body : undefined;
        const idem = method === 'POST' ? { 'idempotency-key': String(req.headers['idempotency-key'] || randomUUID()) } : {};
        const json = await provisioner.request(method, buildPath(req), req.user, body, idem);
        res.status(status).json(json);
      } catch (e) {
        if (e instanceof ProvisionerError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }),
  ];

  // ---- stores: one WooCommerce store per Kubernetes namespace ----
  api.get('/stores', ...forward('GET', () => '/stores'));
  api.post('/stores', ...forward('POST', () => '/stores', { status: 202 }));
  api.delete('/stores/:id', ...forward('DELETE', (req) => `/stores/${encodeURIComponent(req.params.id)}`, { status: 202 }));

  // ---- hosted MCP servers: an admin deploys a container image into the cluster ----
  api.get('/hosted', ...forward('GET', () => '/hosted', { adminOnly: true }));
  api.post('/hosted', ...forward('POST', () => '/hosted', { adminOnly: true, status: 202 }));
  api.delete(
    '/hosted/:id',
    ...forward('DELETE', (req) => `/hosted/${encodeURIComponent(req.params.id)}`, { adminOnly: true, status: 202 }),
  );
}
