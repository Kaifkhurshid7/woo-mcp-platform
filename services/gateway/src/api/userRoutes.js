/** Team management: invite, role changes, disable and delete (admin only). */
import { randomToken, sha256, uuid } from '../crypto.js';
import { EMAIL_RE, HttpError, bad, wrap } from './http.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

export function mountUserRoutes(api, { db, auth }) {
  const userView = async (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: !!u.disabled,
    pendingInvite: !u.password_hash,
    createdAt: u.created_at,
    activeKeys: (await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', [u.id])).n,
  });

  async function newInvite(userId) {
    const token = randomToken(24);
    await db.run('UPDATE users SET invite_token_hash=?, invite_expires_at=? WHERE id=?', [
      sha256(token),
      Date.now() + INVITE_TTL_MS,
      userId,
    ]);
    return token;
  }

  const getUser = async (id) => {
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  };

  const otherAdmins = async (id) => (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id != ?", [id])).n;

  api.get(
    '/users',
    auth.requireAdmin,
    wrap(async (_req, res) => {
      const users = await db.all('SELECT * FROM users ORDER BY created_at');
      res.json({ users: await Promise.all(users.map(userView)) });
    }),
  );

  api.post(
    '/users',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase();
      const role = req.body?.role === 'admin' ? 'admin' : 'member';
      if (!EMAIL_RE.test(email)) throw bad('A valid email is required');
      if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', [email]))
        throw new HttpError(409, 'A user with this email already exists');
      const id = uuid();
      await db.run('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)', [
        id,
        email,
        String(req.body?.name || '')
          .trim()
          .slice(0, 80),
        role,
        Date.now(),
      ]);
      const inviteToken = await newInvite(id);
      res.status(201).json({ user: await userView(await getUser(id)), inviteToken });
    }),
  );

  api.post(
    '/users/:id/invite',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const u = await getUser(req.params.id);
      res.json({ inviteToken: await newInvite(u.id) });
    }),
  );

  api.patch(
    '/users/:id',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const u = await getUser(req.params.id);
      const role = req.body?.role === undefined ? u.role : req.body.role === 'admin' ? 'admin' : 'member';
      const disabled = req.body?.disabled === undefined ? u.disabled : req.body.disabled ? 1 : 0;
      if ((role !== 'admin' || disabled) && u.role === 'admin' && !u.disabled && (await otherAdmins(u.id)) === 0)
        throw bad('You cannot demote or disable the last active admin');
      await db.run('UPDATE users SET role=?, disabled=?, name=? WHERE id=?', [
        role,
        disabled,
        req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : u.name,
        u.id,
      ]);
      if (disabled) await db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
      res.json({ user: await userView(await getUser(u.id)) });
    }),
  );

  api.delete(
    '/users/:id',
    auth.requireAdmin,
    wrap(async (req, res) => {
      const u = await getUser(req.params.id);
      if (u.id === req.user.id) throw bad('You cannot delete your own account');
      if (u.role === 'admin' && !u.disabled && (await otherAdmins(u.id)) === 0) throw bad('You cannot delete the last active admin');
      await db.run('DELETE FROM users WHERE id = ?', [u.id]); // sessions, keys and OAuth tokens cascade
      res.json({ ok: true });
    }),
  );
}
