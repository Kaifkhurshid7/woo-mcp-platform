import { randomToken, sha256 } from './crypto.js';

const COOKIE = 'gw_session';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export function createAuth({ db, cfg, audit }) {
  function createSession(userId) {
    const token = randomToken(32);
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256(token), userId, now, now + cfg.sessionTtlHours * 3600_000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return token;
  }

  function setSessionCookie(res, token) {
    const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${cfg.sessionTtlHours * 3600}`];
    if (cfg.cookieSecure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`);
  }

  /** Dashboard/API authentication via session cookie. */
  function sessionAuth(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.disabled, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .get(sha256(token));
    if (!row || row.expires_at < Date.now() || row.disabled) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Session expired' });
    }
    req.user = publicUser(row);
    req.sessionHash = sha256(token);
    next();
  }

  const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));

  /** MCP endpoint authentication via `Authorization: Bearer gw_...`. */
  function apiKeyAuth(req, res, next) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const deny = (status, description) => {
      res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", error_description="${description}"`);
      return res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: description }, id: null });
    };
    if (!m) return deny(401, 'Missing API key. Send "Authorization: Bearer <your gateway key>".');
    const row = db
      .prepare(
        `SELECT k.id AS key_id, k.revoked_at, k.last_used_at, u.id, u.email, u.name, u.role, u.disabled
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
      )
      .get(sha256(m[1]));
    if (!row) return deny(401, 'Invalid API key.');
    if (row.revoked_at || row.disabled) {
      // Attribute the rejected attempt to the key's owner so revocation shows up in the audit log.
      audit({ user: row, source: 'mcp', tool: '(authentication)', outcome: 'rejected', error: row.revoked_at ? 'API key revoked' : 'user disabled' });
      return deny(401, row.revoked_at ? 'This API key has been revoked.' : 'This account is disabled.');
    }
    const now = Date.now();
    if (!row.last_used_at || now - row.last_used_at > 60_000) {
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.key_id);
    }
    req.user = publicUser(row);
    next();
  }

  return { createSession, setSessionCookie, clearSessionCookie, sessionAuth, requireAdmin, apiKeyAuth, publicUser };
}
