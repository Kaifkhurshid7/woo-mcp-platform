/** Personal API keys (hashed at rest, shown once) and OAuth connections. */
import { generateApiKey, uuid } from '../crypto.js';
import { HttpError, bad, wrap } from './http.js';

export function mountKeyRoutes(api, { db, cfg }) {
  const keyView = (k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    ...(k.email ? { owner: k.email, ownerId: k.user_id } : {}),
  });

  api.get(
    '/keys',
    wrap(async (req, res) => {
      const all = req.query.all === '1' && req.user.role === 'admin';
      const keys = all
        ? await db.all('SELECT k.*, u.email FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC')
        : await db.all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
      res.json({ keys: keys.map(keyView) });
    }),
  );

  api.post(
    '/keys',
    wrap(async (req, res) => {
      const name =
        String(req.body?.name || '')
          .trim()
          .slice(0, 80) || 'My key';
      let ownerId = req.user.id;
      if (req.body?.userId && req.body.userId !== req.user.id) {
        if (req.user.role !== 'admin') throw new HttpError(403, 'Only admins can issue keys for other users');
        if (!(await db.get('SELECT 1 AS x FROM users WHERE id = ? AND disabled = 0', [req.body.userId])))
          throw new HttpError(404, 'User not found');
        ownerId = req.body.userId;
      }
      const { n: active } = await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', [ownerId]);
      if (active >= cfg.maxKeysPerUser) throw bad(`At most ${cfg.maxKeysPerUser} active keys per user. Revoke one first.`);
      const { key, hash, prefix } = generateApiKey();
      const id = uuid();
      await db.run('INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)', [
        id,
        ownerId,
        name,
        prefix,
        hash,
        Date.now(),
      ]);
      // The plaintext key is returned exactly once; only its hash is stored.
      res.status(201).json({ key, record: keyView(await db.get('SELECT * FROM api_keys WHERE id = ?', [id])) });
    }),
  );

  api.delete(
    '/keys/:id',
    wrap(async (req, res) => {
      const k = await db.get('SELECT * FROM api_keys WHERE id = ?', [req.params.id]);
      if (!k || (k.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Key not found');
      await db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [Date.now(), k.id]);
      res.json({ ok: true });
    }),
  );

  // ---- OAuth connections: MCP clients the user signed in with a browser ----
  api.get(
    '/oauth/grants',
    wrap(async (req, res) => {
      const rows = await db.all(
        `SELECT c.client_id, c.client_name, MIN(t.created_at) AS since, MAX(t.created_at) AS last_issued
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > ? GROUP BY c.client_id, c.client_name`,
        [req.user.id, Date.now()],
      );
      res.json({ grants: rows.map((g) => ({ clientId: g.client_id, name: g.client_name, since: g.since, lastIssued: g.last_issued })) });
    }),
  );

  api.delete(
    '/oauth/grants/:clientId',
    wrap(async (req, res) => {
      await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL', [
        Date.now(),
        req.user.id,
        req.params.clientId,
      ]);
      res.json({ ok: true });
    }),
  );
}
