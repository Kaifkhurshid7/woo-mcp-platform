/** Audit log and per-server call statistics. Admins see everything, members only their own calls. */
import { wrap } from './http.js';

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

export function mountAuditRoutes(api, { db }) {
  api.get(
    '/audit',
    wrap(async (req, res) => {
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
      const rows = await db.all(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, [
        ...params,
        limit,
      ]);
      res.json({
        entries: rows.map((a) => ({
          id: a.id,
          ts: a.ts,
          user: a.user_email,
          source: a.source,
          server: a.server_slug,
          tool: a.tool,
          durationMs: a.duration_ms,
          outcome: a.outcome,
          error: a.error,
          args: a.args,
        })),
        nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
      });
    }),
  );

  /** Calls, error rate and latency per server over a time window (default 24 h). */
  api.get(
    '/stats',
    wrap(async (req, res) => {
      const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
      const since = Date.now() - hours * 3600_000;
      const own = req.user.role === 'admin' ? '' : ' AND user_id = ?';
      const params = req.user.role === 'admin' ? [since] : [since, req.user.id];
      const rows = await db.all(
        `SELECT server_slug, outcome, duration_ms FROM audit WHERE ts > ? AND server_slug IS NOT NULL${own} ORDER BY id DESC LIMIT 20000`,
        params,
      );
      const byServer = new Map();
      for (const r of rows) {
        const s = byServer.get(r.server_slug) || { server: r.server_slug, calls: 0, errors: 0, durations: [] };
        s.calls++;
        if (r.outcome !== 'success') s.errors++;
        if (r.duration_ms != null) s.durations.push(r.duration_ms);
        byServer.set(r.server_slug, s);
      }
      res.json({
        hours,
        servers: [...byServer.values()].map(({ durations, ...s }) => {
          durations.sort((a, b) => a - b);
          return { ...s, errorRate: s.calls ? s.errors / s.calls : 0, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95) };
        }),
      });
    }),
  );
}
