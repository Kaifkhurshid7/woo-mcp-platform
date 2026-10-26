import { hashPassword, uuid } from './crypto.js';

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (Kubernetes Secret) if there are no users yet. */
export function bootstrapAdmin(db, cfg, log = console) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  if (!cfg.adminEmail || !cfg.adminPassword) {
    log.warn('[bootstrap] No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set: nobody will be able to sign in.');
    return;
  }
  if (cfg.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)').run(uuid(), cfg.adminEmail, 'Admin', 'admin', hashPassword(cfg.adminPassword), Date.now());
  log.log(`[bootstrap] created admin ${cfg.adminEmail}`);
}

/**
 * Register the servers listed in SEED_SERVERS (rendered by Helm), e.g. the WooCommerce MCP server as
 * the first one. Only slugs that do not exist yet are created, so admin edits are never overwritten.
 */
export function seedServers(db, cfg, vault, log = console) {
  for (const s of cfg.seedServers) {
    if (!s.slug || !s.url) continue;
    if (db.prepare('SELECT 1 FROM servers WHERE slug = ?').get(s.slug)) continue;
    const now = Date.now();
    db.prepare('INSERT INTO servers (id, slug, name, url, enabled, cred_enc, admin_only_tools, status, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      uuid(), s.slug, s.name || s.slug, s.url, 1, s.credential ? vault.encrypt(JSON.stringify(s.credential)) : null, s.adminOnlyTools || '', 'unknown', now + (s.order || 0), now, 'seed',
    );
    log.log(`[seed] registered upstream ${s.slug} -> ${s.url}`);
  }
}
