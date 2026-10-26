/**
 * OAuth 2.1 authorization server for the MCP endpoints (MCP authorization spec, 2025-06-18).
 *
 * Lets an MCP client such as Claude Code, Cursor or MCP Inspector connect with a browser login instead of a
 * pasted API key. Implemented pieces:
 *
 *   RFC 9728  /.well-known/oauth-protected-resource   which authorization server protects /mcp
 *   RFC 8414  /.well-known/oauth-authorization-server authorization server metadata
 *   RFC 7591  POST /oauth/register                    dynamic client registration (public clients)
 *   OAuth 2.1 GET|POST /oauth/authorize               authorization code + mandatory PKCE (S256)
 *   OAuth 2.1 POST /oauth/token                       code exchange and refresh-token rotation
 *
 * Tokens are opaque random strings stored only as SHA-256 hashes. An access token resolves to the same user
 * and role as a personal API key would, so permissions, rate limits and audit behave identically.
 */
import crypto from 'node:crypto';
import express from 'express';
import { randomToken, sha256, uuid, verifyPassword } from './crypto.js';

const CODE_TTL_MS = 5 * 60_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Redirect URIs must be https, loopback http, or a custom app scheme. Never javascript:/data:/file:. */
function validRedirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(u.protocol)) return false;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return true;
}

const page = (
  title,
  body,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;background:#0f1419;color:#e6e9ee;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1a2029;border:1px solid #2b3441;border-radius:12px;padding:28px;width:min(420px,92vw)}
h1{font-size:19px;margin:0 0 6px} p{color:#aab3c0;margin:6px 0 16px} label{display:block;font-size:13px;color:#aab3c0;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid #2b3441;background:#0f1419;color:#e6e9ee}
.row{display:flex;gap:10px;margin-top:20px} button{flex:1;padding:10px;border-radius:8px;border:0;font-weight:600;cursor:pointer}
.ok{background:#3b82f6;color:#fff} .no{background:#2b3441;color:#e6e9ee} .err{color:#f87171}
</style></head><body><main>${body}</main></body></html>`;

/**
 * @param {import('express').Express} app
 */
export function mountOAuth(app, { db, cfg, auth }) {
  if (!cfg.oauth.enabled) return;
  const base = (req) => auth.baseUrl(req);

  const resourceMetadata = (req, res) =>
    res.json({
      resource: `${base(req)}/mcp`,
      authorization_servers: [base(req)],
      bearer_methods_supported: ['header'],
      resource_name: 'MCP Gateway',
    });
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const b = base(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  const oauth = express.Router();
  oauth.use(express.urlencoded({ extended: false, limit: '20kb' }));
  oauth.use(express.json({ limit: '20kb' }));

  // ---- RFC 7591 dynamic client registration ----
  oauth.post(
    '/register',
    auth.safe(async (req, res) => {
      const uris = req.body?.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirectUri(u))) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be https, loopback http, or a custom app scheme.',
        });
      }
      const clientId = `mcp_${uuid().replace(/-/g, '')}`;
      const name = String(req.body?.client_name || 'MCP client').slice(0, 80);
      await db.run('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?,?,?,?)', [
        clientId,
        name,
        JSON.stringify(uris),
        Date.now(),
      ]);
      res.status(201).json({
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }),
  );

  /** Validate the authorize request's parameters. Returns { client, params } or { error } (to be shown, not redirected). */
  async function checkAuthorizeParams(p) {
    const client = await db.get('SELECT * FROM oauth_clients WHERE client_id = ?', [String(p.client_id || '')]);
    if (!client) return { error: 'Unknown client.' };
    if (!JSON.parse(client.redirect_uris).includes(p.redirect_uri)) return { error: 'The redirect URI does not match the registered one.' };
    if (p.response_type !== 'code') return { client, redirectError: 'unsupported_response_type' };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { client, redirectError: 'invalid_request' };
    return { client };
  }

  const redirectBack = (res, uri, params) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };

  const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
  const hidden = (p) => FIELDS.map((f) => `<input type="hidden" name="${f}" value="${esc(p[f])}">`).join('');
  /** CSRF token bound to the signed-in session and the exact request parameters. */
  const csrfFor = (sessionHash, p) => sha256(`${sessionHash}|${FIELDS.map((f) => p[f] || '').join('|')}|csrf`);

  oauth.get(
    '/authorize',
    auth.safe(async (req, res) => {
      const p = req.query;
      const checked = await checkAuthorizeParams(p);
      if (checked.error)
        return res
          .status(400)
          .type('html')
          .send(page('Authorization error', `<h1>Authorization error</h1><p class="err">${esc(checked.error)}</p>`));
      if (checked.redirectError) return redirectBack(res, p.redirect_uri, { error: checked.redirectError, state: p.state });
      const user = await auth.userFromSession(req);
      const who = user
        ? `<p>Signed in as <b>${esc(user.email)}</b>.</p><input type="hidden" name="csrf" value="${csrfFor(user.sessionHash, p)}">`
        : `<label>Email</label><input name="email" type="email" required autofocus><label>Password</label><input name="password" type="password" required>`;
      res.type('html').send(
        page(
          'Authorize access',
          `<h1>Connect ${esc(checked.client.client_name)}</h1>
           <p>This app wants to use your team's MCP tools through the gateway, acting as you. Your upstream credentials are never shared.</p>
           <form method="post" action="/oauth/authorize">${hidden(p)}${who}
             <div class="row"><button class="no" name="decision" value="deny" formnovalidate>Deny</button><button class="ok" name="decision" value="allow">${user ? 'Allow' : 'Sign in &amp; allow'}</button></div>
           </form>`,
        ),
      );
    }),
  );

  oauth.post(
    '/authorize',
    auth.safe(async (req, res) => {
      const p = req.body;
      const checked = await checkAuthorizeParams(p);
      if (checked.error)
        return res
          .status(400)
          .type('html')
          .send(page('Authorization error', `<h1>Authorization error</h1><p class="err">${esc(checked.error)}</p>`));
      if (checked.redirectError) return redirectBack(res, p.redirect_uri, { error: checked.redirectError, state: p.state });
      if (p.decision !== 'allow') return redirectBack(res, p.redirect_uri, { error: 'access_denied', state: p.state });

      let userId;
      const sessionUser = await auth.userFromSession(req);
      if (sessionUser) {
        if (p.csrf !== csrfFor(sessionUser.sessionHash, p))
          return res
            .status(403)
            .type('html')
            .send(page('Forbidden', '<h1>Forbidden</h1><p class="err">Invalid form token. Go back and try again.</p>'));
        userId = sessionUser.id;
      } else {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [
          String(p.email || '')
            .trim()
            .toLowerCase(),
        ]);
        const ok = user && user.password_hash && !user.disabled && verifyPassword(String(p.password || ''), user.password_hash);
        if (!ok) {
          return res
            .status(401)
            .type('html')
            .send(
              page(
                'Sign in failed',
                `<h1>Sign in failed</h1><p class="err">Invalid email or password.</p><p><a style="color:#60a5fa" href="javascript:history.back()">Try again</a></p>`,
              ),
            );
        }
        userId = user.id;
      }

      const code = randomToken(32);
      await db.run(
        'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES (?,?,?,?,?,?)',
        [sha256(code), p.client_id, userId, p.redirect_uri, p.code_challenge, Date.now() + CODE_TTL_MS],
      );
      await db.run('DELETE FROM oauth_codes WHERE expires_at < ?', [Date.now()]);
      redirectBack(res, p.redirect_uri, { code, state: p.state });
    }),
  );

  /** Create an access + refresh token pair for (client, user). */
  async function issueTokens(clientId, userId) {
    const now = Date.now();
    const access = `gwo_${randomToken(32)}`;
    const refresh = `gwr_${randomToken(32)}`;
    await db.run('INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?)', [
      sha256(access),
      'access',
      clientId,
      userId,
      now,
      now + cfg.oauth.accessTtlSec * 1000,
    ]);
    await db.run('INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?)', [
      sha256(refresh),
      'refresh',
      clientId,
      userId,
      now,
      now + cfg.oauth.refreshTtlSec * 1000,
    ]);
    return { access_token: access, token_type: 'Bearer', expires_in: cfg.oauth.accessTtlSec, refresh_token: refresh, scope: 'mcp' };
  }

  const tokenError = (res, error, description) =>
    res.status(400).set('Cache-Control', 'no-store').json({ error, error_description: description });

  oauth.post(
    '/token',
    auth.safe(async (req, res) => {
      const p = req.body || {};
      if (p.grant_type === 'authorization_code') {
        const row = await db.get('SELECT * FROM oauth_codes WHERE code_hash = ?', [sha256(String(p.code || ''))]);
        if (!row) return tokenError(res, 'invalid_grant', 'Unknown or already used code.');
        await db.run('DELETE FROM oauth_codes WHERE code_hash = ?', [row.code_hash]); // single use
        if (row.expires_at < Date.now()) return tokenError(res, 'invalid_grant', 'The code has expired.');
        if (row.client_id !== p.client_id || row.redirect_uri !== p.redirect_uri)
          return tokenError(res, 'invalid_grant', 'Client or redirect URI mismatch.');
        const challenge = crypto
          .createHash('sha256')
          .update(String(p.code_verifier || ''))
          .digest('base64url');
        const a = Buffer.from(challenge);
        const b = Buffer.from(row.code_challenge);
        if (!p.code_verifier || a.length !== b.length || !crypto.timingSafeEqual(a, b))
          return tokenError(res, 'invalid_grant', 'PKCE verification failed.');
        return res.set('Cache-Control', 'no-store').json(await issueTokens(row.client_id, row.user_id));
      }
      if (p.grant_type === 'refresh_token') {
        const row = await db.get("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", [
          sha256(String(p.refresh_token || '')),
        ]);
        if (!row || row.revoked_at || row.expires_at < Date.now() || row.client_id !== p.client_id)
          return tokenError(res, 'invalid_grant', 'Invalid refresh token.');
        const user = await db.get('SELECT disabled FROM users WHERE id = ?', [row.user_id]);
        if (!user || user.disabled) return tokenError(res, 'invalid_grant', 'This account is disabled.');
        await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?', [Date.now(), row.token_hash]); // rotation
        return res.set('Cache-Control', 'no-store').json(await issueTokens(row.client_id, row.user_id));
      }
      return tokenError(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }),
  );

  app.use('/oauth', oauth);
}
