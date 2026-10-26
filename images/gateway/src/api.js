import express from 'express';
import { generateApiKey, hashPassword, randomToken, sha256, uuid, verifyPassword } from './crypto.js';
import { exposedName } from './router.js';
import { assertSafeUpstreamUrl, UnsafeUrlError } from './ssrf.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept', 'mcp-session-id', 'mcp-protocol-version']);
const INVITE_TTL_MS = 7 * 24 * 3600_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');

export function mountApi(app, { db, cfg, vault, auth, upstreams, router, llm, chat }) {
  const api = express.Router();

  // ---- CSRF defence in depth: cookies are SameSite=Lax; additionally refuse cross-origin writes ----
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

  // ================= auth =================
  const attempts = new Map();
  const throttled = (k) => {
    const now = Date.now();
    const a = attempts.get(k);
    if (!a || a.resetAt < now) return false;
    return a.count >= 10;
  };
  const noteFailure = (k) => {
    const now = Date.now();
    const a = attempts.get(k);
    if (!a || a.resetAt < now) attempts.set(k, { count: 1, resetAt: now + 5 * 60_000 });
    else a.count++;
  };

  api.post(
    '/auth/login',
    wrap(async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const k = `${req.ip}|${email}`;
      if (throttled(k)) throw new HttpError(429, 'Too many failed attempts. Wait a few minutes and try again.');
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      // Always run a hash comparison so response time doesn't reveal whether the account exists.
      const valid = verifyPassword(password, user?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      if (!user || !user.password_hash || !valid || user.disabled) {
        noteFailure(k);
        throw new HttpError(401, 'Invalid email or password');
      }
      attempts.delete(k);
      auth.setSessionCookie(res, auth.createSession(user.id));
      res.json({ user: auth.publicUser(user) });
    }),
  );

  api.post('/auth/logout', (req, res) => {
    const token = (req.headers.cookie || '').match(/gw_session=([^;]+)/)?.[1];
    if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(decodeURIComponent(token)));
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.get('/auth/invite', (req, res) => {
    const u = db.prepare('SELECT email, name FROM users WHERE invite_token_hash = ? AND invite_expires_at > ?').get(sha256(String(req.query.token || '')), Date.now());
    if (!u) return res.status(404).json({ error: 'This invitation is invalid or has expired.' });
    res.json(u);
  });

  api.post(
    '/auth/accept-invite',
    wrap(async (req, res) => {
      const { token, password, name } = req.body || {};
      if (typeof password !== 'string' || password.length < 10) throw bad('Password must be at least 10 characters');
      const u = db.prepare('SELECT * FROM users WHERE invite_token_hash = ? AND invite_expires_at > ?').get(sha256(String(token || '')), Date.now());
      if (!u) throw new HttpError(404, 'This invitation is invalid or has expired.');
      db.prepare('UPDATE users SET password_hash=?, invite_token_hash=NULL, invite_expires_at=NULL, name=? WHERE id=?').run(hashPassword(password), String(name || u.name || '').trim().slice(0, 80), u.id);
      auth.setSessionCookie(res, auth.createSession(u.id));
      res.json({ user: auth.publicUser({ ...u, name: name || u.name }) });
    }),
  );

  // Everything below needs a signed-in user.
  api.use(auth.sessionAuth);

  api.get('/auth/me', (req, res) => res.json({ user: req.user }));

  api.get('/config', (req, res) => {
    const base = cfg.publicUrl || `${req.protocol}://${req.get('host')}`;
    res.json({
      mcpUrl: `${base}/mcp`,
      llm: { provider: llm.provider, model: llm.model, configured: llm.configured, reason: llm.reason },
      rateLimitPerMin: cfg.rateLimitPerMin,
    });
  });

  // ================= servers =================
  function serverView(r, admin) {
    const st = upstreams.state.get(r.id);
    const status = upstreams.statusOf(r);
    const view = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      enabled: !!r.enabled,
      status,
      lastCheckedAt: st?.checkedAt ?? r.last_checked_at ?? null,
      latencyMs: st?.latencyMs ?? null,
      tools: r.enabled ? upstreams.toolsOf(r).map((t) => ({ name: t.name, exposedName: exposedName(r.slug, t.name), description: t.description || '' })) : [],
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
        source: r.source,
      });
    }
    return view;
  }

  function parseCredential(input) {
    if (input === undefined) return undefined; // keep as is
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

  const checkUrl = async (url) => {
    try {
      await assertSafeUpstreamUrl(url, { allowPrivate: cfg.allowPrivateUpstreams, allowLoopback: cfg.allowLoopbackUpstreams });
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw bad(`URL rejected: ${e.message}`);
      throw e;
    }
  };

  api.get('/servers', (req, res) => {
    const admin = req.user.role === 'admin';
    res.json({ servers: upstreams.rows().map((r) => serverView(r, admin)) });
  });

  api.post(
    '/servers',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name || name.length > 80) throw bad('Name is required (max 80 characters)');
      const slug = String(b.slug || slugify(name));
      if (!SLUG_RE.test(slug)) throw bad('Slug must be lowercase letters, digits and dashes (max 24 chars)');
      if (db.prepare('SELECT 1 FROM servers WHERE slug = ?').get(slug)) throw new HttpError(409, `A server with slug "${slug}" already exists`);
      const url = String(b.url || '').trim();
      await checkUrl(url);
      const cred = parseCredential(b.credential);
      const id = uuid();
      const now = Date.now();
      db.prepare('INSERT INTO servers (id, slug, name, url, enabled, cred_enc, admin_only_tools, status, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id, slug, name, url, b.enabled === false ? 0 : 1, cred ? vault.encrypt(JSON.stringify(cred)) : null, String(b.adminOnlyTools || '').slice(0, 500), 'unknown', now, now, 'manual',
      );
      await Promise.race([upstreams.refresh(id), sleep(cfg.listTimeoutMs + 2000)]);
      res.status(201).json({ server: serverView(upstreams.row(id), true) });
    }),
  );

  api.put(
    '/servers/:id',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const r = upstreams.row(req.params.id);
      if (!r) throw new HttpError(404, 'Server not found');
      const b = req.body || {};
      const name = b.name !== undefined ? String(b.name).trim() : r.name;
      if (!name || name.length > 80) throw bad('Name is required (max 80 characters)');
      const url = b.url !== undefined ? String(b.url).trim() : r.url;
      if (url !== r.url) await checkUrl(url);
      const cred = parseCredential(b.credential);
      const credEnc = cred === undefined ? r.cred_enc : cred ? vault.encrypt(JSON.stringify(cred)) : null;
      const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : r.enabled;
      const adminOnly = b.adminOnlyTools !== undefined ? String(b.adminOnlyTools).slice(0, 500) : r.admin_only_tools;
      db.prepare('UPDATE servers SET name=?, url=?, cred_enc=?, enabled=?, admin_only_tools=?, updated_at=? WHERE id=?').run(name, url, credEnc, enabled, adminOnly, Date.now(), r.id);
      if (!enabled) upstreams.state.set(r.id, { status: 'disabled', tools: [], checkedAt: Date.now() }); // tools vanish immediately
      await Promise.race([upstreams.refresh(r.id), sleep(cfg.listTimeoutMs + 2000)]);
      res.json({ server: serverView(upstreams.row(r.id), true) });
    }),
  );

  api.post(
    '/servers/:id/refresh',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const r = upstreams.row(req.params.id);
      if (!r) throw new HttpError(404, 'Server not found');
      await Promise.race([upstreams.refresh(r.id), sleep(cfg.listTimeoutMs + 2000)]);
      res.json({ server: serverView(upstreams.row(r.id), true) });
    }),
  );

  api.delete('/servers/:id', auth.requireAdmin, (req, res) => {
    const r = upstreams.row(req.params.id);
    if (!r) throw new HttpError(404, 'Server not found');
    db.prepare('DELETE FROM servers WHERE id = ?').run(r.id);
    upstreams.forget(r.id);
    res.json({ ok: true });
  });

  // ================= users =================
  const userView = (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: !!u.disabled,
    pendingInvite: !u.password_hash,
    createdAt: u.created_at,
    activeKeys: db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(u.id).n,
  });

  function newInvite(userId) {
    const token = randomToken(24);
    db.prepare('UPDATE users SET invite_token_hash=?, invite_expires_at=? WHERE id=?').run(sha256(token), Date.now() + INVITE_TTL_MS, userId);
    return token;
  }

  api.get('/users', auth.requireAdmin, (_req, res) => {
    res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userView) });
  });

  api.post(
    '/users',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const role = req.body?.role === 'admin' ? 'admin' : 'member';
      if (!EMAIL_RE.test(email)) throw bad('A valid email is required');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'A user with this email already exists');
      const id = uuid();
      db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)').run(id, email, String(req.body?.name || '').trim().slice(0, 80), role, Date.now());
      const inviteToken = newInvite(id);
      res.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), inviteToken });
    }),
  );

  api.post('/users/:id/invite', auth.requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    res.json({ inviteToken: newInvite(u.id) });
  });

  const otherAdmins = (id) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id != ?").get(id).n;

  api.patch('/users/:id', auth.requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const role = req.body?.role === undefined ? u.role : req.body.role === 'admin' ? 'admin' : 'member';
    const disabled = req.body?.disabled === undefined ? u.disabled : req.body.disabled ? 1 : 0;
    if ((role !== 'admin' || disabled) && u.role === 'admin' && !u.disabled && otherAdmins(u.id) === 0) throw bad('You cannot demote or disable the last active admin');
    db.prepare('UPDATE users SET role=?, disabled=?, name=? WHERE id=?').run(role, disabled, req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : u.name, u.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.json({ user: userView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });

  api.delete('/users/:id', auth.requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.id === req.user.id) throw bad('You cannot delete your own account');
    if (u.role === 'admin' && !u.disabled && otherAdmins(u.id) === 0) throw bad('You cannot delete the last active admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // sessions + keys cascade
    res.json({ ok: true });
  });

  // ================= API keys =================
  const keyView = (k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    ...(k.email ? { owner: k.email, ownerId: k.user_id } : {}),
  });

  api.get('/keys', (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const keys = all
      ? db.prepare('SELECT k.*, u.email FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC').all()
      : db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ keys: keys.map(keyView) });
  });

  api.post(
    '/keys',
    wrap(async (req, res) => {
      const name = String(req.body?.name || '').trim().slice(0, 80) || 'My key';
      let ownerId = req.user.id;
      if (req.body?.userId && req.body.userId !== req.user.id) {
        if (req.user.role !== 'admin') throw new HttpError(403, 'Only admins can issue keys for other users');
        if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').get(req.body.userId)) throw new HttpError(404, 'User not found');
        ownerId = req.body.userId;
      }
      const active = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(ownerId).n;
      if (active >= cfg.maxKeysPerUser) throw bad(`At most ${cfg.maxKeysPerUser} active keys per user. Revoke one first.`);
      const { key, hash, prefix } = generateApiKey();
      const id = uuid();
      db.prepare('INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)').run(id, ownerId, name, prefix, hash, Date.now());
      // The plaintext key is returned exactly once; only its hash is stored.
      res.status(201).json({ key, record: keyView(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)) });
    }),
  );

  api.delete('/keys/:id', (req, res) => {
    const k = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id);
    if (!k || (k.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Key not found');
    db.prepare('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), k.id);
    res.json({ ok: true });
  });

  // ================= audit =================
  api.get('/audit', (req, res) => {
    const where = [];
    const params = [];
    if (req.user.role !== 'admin') {
      where.push('user_id = ?');
      params.push(req.user.id);
    } else if (req.query.user) {
      where.push('user_email = ?');
      params.push(String(req.query.user));
    }
    if (req.query.server) (where.push('server_slug = ?'), params.push(String(req.query.server)));
    if (req.query.outcome) (where.push('outcome = ?'), params.push(String(req.query.outcome)));
    if (req.query.before) (where.push('id < ?'), params.push(Number(req.query.before)));
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...params, limit);
    res.json({
      entries: rows.map((a) => ({ id: a.id, ts: a.ts, user: a.user_email, source: a.source, server: a.server_slug, tool: a.tool, durationMs: a.duration_ms, outcome: a.outcome, error: a.error, args: a.args })),
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  });

  // ================= chat =================
  api.post(
    '/chat',
    wrap(async (req, res) => {
      const message = String(req.body?.message || '').trim();
      if (!message) throw bad('message is required');
      if (message.length > 4000) throw bad('message is too long');
      const history = (Array.isArray(req.body?.history) ? req.body.history : [])
        .filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string' && h.content.trim())
        .slice(-20)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 8000) }));
      res.json(await chat.run(req.user, history, message));
    }),
  );

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.status === 503) return res.status(503).json({ error: err.message });
    console.error('[api] unhandled error', err);
    res.status(502).json({ error: err?.message ? String(err.message).slice(0, 300) : 'Internal error' });
  });

  app.use('/api', api);
}
