/** Public auth routes: password login, logout and invitation acceptance. */
import { hashPassword, sha256, verifyPassword } from '../crypto.js';
import { HttpError, bad, wrap } from './http.js';

/** A real-looking scrypt hash used to keep login timing constant when the account does not exist. */
const DUMMY_HASH = `scrypt$AAAAAAAAAAAAAAAAAAAAAA==$${'A'.repeat(86)}==`;

export function mountAuthRoutes(api, { db, auth }) {
  // Brute-force throttle per (ip, email): 10 failures in 5 minutes. Per replica, which is fine for defence in depth.
  const attempts = new Map();
  const throttled = (k) => {
    const a = attempts.get(k);
    return !!a && a.resetAt >= Date.now() && a.count >= 10;
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
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || '');
      const k = `${req.ip}|${email}`;
      if (throttled(k)) throw new HttpError(429, 'Too many failed attempts. Wait a few minutes and try again.');
      const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      // Always run a hash comparison so response time does not reveal whether the account exists.
      const valid = verifyPassword(password, user?.password_hash || DUMMY_HASH);
      if (!user || !user.password_hash || !valid || user.disabled) {
        noteFailure(k);
        throw new HttpError(401, 'Invalid email or password');
      }
      attempts.delete(k);
      auth.setSessionCookie(res, await auth.createSession(user.id));
      res.json({ user: auth.publicUser(user) });
    }),
  );

  api.post(
    '/auth/logout',
    wrap(async (req, res) => {
      const token = (req.headers.cookie || '').match(/gw_session=([^;]+)/)?.[1];
      if (token) await db.run('DELETE FROM sessions WHERE id_hash = ?', [sha256(decodeURIComponent(token))]);
      auth.clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  api.get(
    '/auth/invite',
    wrap(async (req, res) => {
      const u = await db.get('SELECT email, name FROM users WHERE invite_token_hash = ? AND invite_expires_at > ?', [
        sha256(String(req.query.token || '')),
        Date.now(),
      ]);
      if (!u) throw new HttpError(404, 'This invitation is invalid or has expired.');
      res.json(u);
    }),
  );

  api.post(
    '/auth/accept-invite',
    wrap(async (req, res) => {
      const { token, password, name } = req.body || {};
      if (typeof password !== 'string' || password.length < 10) throw bad('Password must be at least 10 characters');
      const u = await db.get('SELECT * FROM users WHERE invite_token_hash = ? AND invite_expires_at > ?', [
        sha256(String(token || '')),
        Date.now(),
      ]);
      if (!u) throw new HttpError(404, 'This invitation is invalid or has expired.');
      await db.run('UPDATE users SET password_hash=?, invite_token_hash=NULL, invite_expires_at=NULL, name=? WHERE id=?', [
        hashPassword(password),
        String(name || u.name || '')
          .trim()
          .slice(0, 80),
        u.id,
      ]);
      auth.setSessionCookie(res, await auth.createSession(u.id));
      res.json({ user: auth.publicUser({ ...u, name: name || u.name }) });
    }),
  );
}
