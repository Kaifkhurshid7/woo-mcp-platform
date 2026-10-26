/** Upstream MCP server registry: list, add, edit, enable/disable, refresh and remove. */
import { uuid } from '../crypto.js';
import { exposedName } from '../router.js';
import { assertSafeUpstreamUrl, UnsafeUrlError } from '../ssrf.js';
import { HttpError, SLUG_RE, bad, slugify, sleep, wrap } from './http.js';

/** Header names an admin may not use for a credential (they would break the MCP transport). */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
]);

/** Servers created by the provisioner (stores, hosted images) can be toggled but not edited or removed here. */
const isManaged = (r) => r.source === 'store' || r.source === 'hosted';

/** Validate a credential payload. Returns undefined (keep), null (remove) or the normalised credential. */
function parseCredential(input) {
  if (input === undefined) return undefined;
  if (input === null || input.type === 'none') return null;
  if (input.type === 'bearer') {
    if (typeof input.token !== 'string' || !input.token.trim()) throw bad('Bearer token is empty');
    return { type: 'bearer', token: input.token.trim() };
  }
  if (input.type === 'header') {
    const name = String(input.name || '').trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw bad('Invalid header name');
    if (typeof input.value !== 'string' || !input.value) throw bad('Header value is empty');
    return { type: 'header', name, value: input.value };
  }
  throw bad('credential.type must be none, bearer or header');
}

export function mountServerRoutes(api, { db, cfg, vault, auth, upstreams }) {
  /** What the dashboard sees. Credentials are NEVER included; admins get the URL and credential type only. */
  function serverView(r, admin) {
    const st = upstreams.state.get(r.id);
    const status = upstreams.statusOf(r);
    const view = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      enabled: !!r.enabled,
      status,
      source: r.source,
      managed: isManaged(r),
      lastCheckedAt: st?.checkedAt ?? r.last_checked_at ?? null,
      latencyMs: st?.latencyMs ?? null,
      tools: r.enabled
        ? upstreams.toolsOf(r).map((t) => ({ name: t.name, exposedName: exposedName(r.slug, t.name), description: t.description || '' }))
        : [],
    };
    if (admin) {
      const cred = upstreams.credentialOf(r);
      Object.assign(view, {
        url: r.url,
        error: status === 'unreachable' ? st?.error : null,
        hasCredential: !!cred,
        credentialType: cred?.type || 'none',
        credentialHeader: cred?.type === 'header' ? cred.name : undefined, // header *name* only, never the value
        adminOnlyTools: r.admin_only_tools,
      });
    }
    return view;
  }

  const checkUrl = async (url) => {
    try {
      await assertSafeUpstreamUrl(url, { allowPrivate: cfg.allowPrivateUpstreams, allowLoopback: cfg.allowLoopbackUpstreams });
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw bad(`URL rejected: ${e.message}`);
      throw e;
    }
  };

  /** Reload the cache, re-check one server and wait (bounded) for the answer so the UI shows fresh status. */
  const settle = async (id) => {
    await upstreams.reload();
    await Promise.race([upstreams.refresh(id), sleep(cfg.listTimeoutMs + 2000)]);
  };

  api.get(
    '/servers',
    wrap(async (req, res) => {
      await upstreams.ensureFresh();
      const admin = req.user.role === 'admin';
      res.json({ servers: upstreams.rows().map((r) => serverView(r, admin)) });
    }),
  );

  api.post(
    '/servers',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name || name.length > 80) throw bad('Name is required (max 80 characters)');
      const slug = String(b.slug || slugify(name));
      if (!SLUG_RE.test(slug)) throw bad('Slug must be lowercase letters, digits and dashes (max 24 chars)');
      if (await db.get('SELECT 1 AS x FROM servers WHERE slug = ?', [slug]))
        throw new HttpError(409, `A server with slug "${slug}" already exists`);
      const url = String(b.url || '').trim();
      await checkUrl(url);
      const cred = parseCredential(b.credential);
      const id = uuid();
      const now = Date.now();
      await db.run(
        'INSERT INTO servers (id, slug, name, url, enabled, cred_enc, admin_only_tools, status, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          slug,
          name,
          url,
          b.enabled === false ? 0 : 1,
          cred ? vault.encrypt(JSON.stringify(cred)) : null,
          String(b.adminOnlyTools || '').slice(0, 500),
          'unknown',
          now,
          now,
          'manual',
        ],
      );
      await settle(id);
      res.status(201).json({ server: serverView(upstreams.row(id), true) });
    }),
  );

  api.put(
    '/servers/:id',
    auth.requireAdmin,
    wrap(async (req, res) => {
      await upstreams.reload();
      const r = upstreams.row(req.params.id);
      if (!r) throw new HttpError(404, 'Server not found');
      const b = req.body || {};
      if (isManaged(r) && (b.url !== undefined || b.credential !== undefined || b.name !== undefined)) {
        throw bad('This server is managed by the platform. You can enable/disable it or change its tool permissions only.');
      }
      const name = b.name !== undefined ? String(b.name).trim() : r.name;
      if (!name || name.length > 80) throw bad('Name is required (max 80 characters)');
      const url = b.url !== undefined ? String(b.url).trim() : r.url;
      if (url !== r.url) await checkUrl(url);
      const cred = parseCredential(b.credential);
      const credEnc = cred === undefined ? r.cred_enc : cred ? vault.encrypt(JSON.stringify(cred)) : null;
      const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : r.enabled;
      const adminOnly = b.adminOnlyTools !== undefined ? String(b.adminOnlyTools).slice(0, 500) : r.admin_only_tools;
      await db.run('UPDATE servers SET name=?, url=?, cred_enc=?, enabled=?, admin_only_tools=?, updated_at=? WHERE id=?', [
        name,
        url,
        credEnc,
        enabled,
        adminOnly,
        Date.now(),
        r.id,
      ]);
      await upstreams.reload();
      if (!enabled) upstreams.state.set(r.id, { status: 'disabled', tools: [], checkedAt: Date.now() }); // tools vanish immediately
      await settle(r.id);
      res.json({ server: serverView(upstreams.row(r.id), true) });
    }),
  );

  api.post(
    '/servers/:id/refresh',
    auth.requireAdmin,
    wrap(async (req, res) => {
      await upstreams.reload();
      const r = upstreams.row(req.params.id);
      if (!r) throw new HttpError(404, 'Server not found');
      await settle(r.id);
      res.json({ server: serverView(upstreams.row(r.id), true) });
    }),
  );

  api.delete(
    '/servers/:id',
    auth.requireAdmin,
    wrap(async (req, res) => {
      await upstreams.reload();
      const r = upstreams.row(req.params.id);
      if (!r) throw new HttpError(404, 'Server not found');
      if (isManaged(r))
        throw bad(
          `This server is managed by the platform (${r.source}). Delete the ${r.source === 'store' ? 'store' : 'hosted server'} instead and it is deregistered automatically.`,
        );
      await db.run('DELETE FROM servers WHERE id = ?', [r.id]);
      upstreams.forget(r.id);
      await upstreams.reload();
      res.json({ ok: true });
    }),
  );
}
