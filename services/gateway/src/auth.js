/**
 * Authentication middleware.
 *
 *  - Dashboard / REST API  -> session cookie (`gw_session`), created by password login.
 *  - MCP endpoints         -> `Authorization: Bearer <token>` where the token is either a personal API key
 *                             (`gw_...`, stored hashed) or an OAuth access token (`gwo_...`, stored hashed).
 */
import { randomToken, sha256 } from './crypto.js';

const COOKIE = 'gw_session';

/** Parse a Cookie header into a plain object. */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

/** Express async middleware wrapper: forwards rejections to the error handler. */
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createAuth({ db, cfg, audit }) {
  async function createSession(userId) {
    const token = randomToken(32);
    const now = Date.now();
    await db.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', [
      sha256(token),
      userId,
      now,
      now + cfg.sessionTtlHours * 3600_000,
    ]);
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
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

  /** Look up the signed-in user for a request's cookie, or undefined. */
  async function userFromSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return undefined;
    const row = await db.get(
      `SELECT u.id, u.email, u.name, u.role, u.disabled, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      [sha256(token)],
    );
    if (!row || row.expires_at < Date.now() || row.disabled) return undefined;
    return { ...publicUser(row), sessionHash: sha256(token) };
  }

  /** Dashboard/API authentication via session cookie. */
  const sessionAuth = safe(async (req, res, next) => {
    const user = await userFromSession(req);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: req.headers.cookie?.includes(COOKIE) ? 'Session expired' : 'Not signed in' });
    }
    req.user = user;
    next();
  });

  const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));

  /** Base URL clients should use to reach this gateway (configured, or derived from the request). */
  const baseUrl = (req) => cfg.publicUrl || `${req.protocol}://${req.get('host')}`;

  /** MCP endpoint authentication: personal API key or OAuth access token. */
  const mcpAuth = safe(async (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const deny = (status, description, code = 'invalid_token') => {
      // `resource_metadata` lets OAuth-capable MCP clients discover how to log in (RFC 9728).
      const meta = cfg.oauth.enabled ? `, resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"` : '';
      res.setHeader('WWW-Authenticate', `Bearer error="${code}", error_description="${description}"${meta}`);
      return res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: description }, id: null });
    };
    if (!m)
      return deny(401, 'Missing credentials. Send "Authorization: Bearer <your gateway key>" or sign in with OAuth.', 'invalid_request');

    const hash = sha256(m[1]);
    let row;
    let via = 'key';
    if (m[1].startsWith('gwo_')) {
      via = 'oauth';
      row = await db.get(
        `SELECT t.expires_at AS tok_expires, t.revoked_at, u.id, u.email, u.name, u.role, u.disabled
         FROM oauth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = 'access'`,
        [hash],
      );
      if (row && row.tok_expires < Date.now()) return deny(401, 'The access token has expired.');
    } else {
      row = await db.get(
        `SELECT k.id AS key_id, k.revoked_at, k.last_used_at, u.id, u.email, u.name, u.role, u.disabled
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
        [hash],
      );
    }
    if (!row) return deny(401, via === 'oauth' ? 'Invalid access token.' : 'Invalid API key.');
    if (row.revoked_at || row.disabled) {
      // Attribute the rejected attempt to the owner so revocation shows up in the audit log.
      await audit({
        user: row,
        source: 'mcp',
        tool: '(authentication)',
        outcome: 'rejected',
        error: row.revoked_at ? `${via} credential revoked` : 'user disabled',
      });
      return deny(
        401,
        row.revoked_at
          ? via === 'oauth'
            ? 'This access token has been revoked.'
            : 'This API key has been revoked.'
          : 'This account is disabled.',
      );
    }
    const now = Date.now();
    if (via === 'key' && (!row.last_used_at || now - row.last_used_at > 60_000)) {
      await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.key_id]);
    }
    req.user = publicUser(row);
    next();
  });

  return {
    createSession,
    setSessionCookie,
    clearSessionCookie,
    userFromSession,
    sessionAuth,
    requireAdmin,
    mcpAuth,
    baseUrl,
    publicUser,
    safe,
  };
}
