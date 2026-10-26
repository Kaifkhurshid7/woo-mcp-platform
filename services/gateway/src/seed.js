/**
 * First-start provisioning of the gateway database: the bootstrap admin and the pre-registered upstream servers.
 */
import { hashPassword, uuid } from './crypto.js';

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (Kubernetes Secret) if there are no users yet. */
export async function bootstrapAdmin(db, cfg, log = console) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users');
  if (n > 0) return;
  if (!cfg.adminEmail || !cfg.adminPassword) {
    log.warn('[bootstrap] No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set: nobody will be able to sign in.');
    return;
  }
  if (cfg.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  await db.run('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)', [
    uuid(),
    cfg.adminEmail,
    'Admin',
    'admin',
    hashPassword(cfg.adminPassword),
    Date.now(),
  ]);
  log.log(`[bootstrap] created admin ${cfg.adminEmail}`);
}

/**
 * Register the servers listed in SEED_SERVERS (rendered by Helm), e.g. the WooCommerce MCP server as
 * the first one. Only slugs that do not exist yet are created, so admin edits are never overwritten.
 */
export async function seedServers(db, cfg, vault, log = console) {
  for (const s of cfg.seedServers) {
    if (!s.slug || !s.url) continue;
    if (await db.get('SELECT 1 AS x FROM servers WHERE slug = ?', [s.slug])) continue;
    const now = Date.now();
    await db.run(
      'INSERT INTO servers (id, slug, name, url, enabled, cred_enc, admin_only_tools, status, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        uuid(),
        s.slug,
        s.name || s.slug,
        s.url,
        1,
        s.credential ? vault.encrypt(JSON.stringify(s.credential)) : null,
        s.adminOnlyTools || '',
        'unknown',
        now + (s.order || 0),
        now,
        'seed',
      ],
    );
    log.log(`[seed] registered upstream ${s.slug} -> ${s.url}`);
  }
}
