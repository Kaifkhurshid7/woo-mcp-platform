/**
 * Database access layer.
 *
 * One tiny async interface (`get`, `all`, `run`) with two interchangeable back ends:
 *
 *  - SQLite  (`node:sqlite`): zero-dependency default for development, tests and single-replica installs.
 *  - Postgres (`pg`)        : used when DATABASE_URL is set. Required to run more than one gateway replica,
 *                             because replicas must share users, API keys, sessions, servers and the audit log.
 *
 * SQL is written once with `?` placeholders and translated to `$1..$n` for Postgres.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Schema shared by both dialects. Timestamps are epoch milliseconds stored as BIGINT
 * (SQLite treats BIGINT as a plain integer). `@AUTOID@` is replaced per dialect.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  password_hash TEXT,
  invite_token_hash TEXT,
  invite_expires_at BIGINT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_token_hash);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cred_enc TEXT,
  admin_only_tools TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  last_checked_at BIGINT,
  latency_ms INTEGER,
  tools_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  ref TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id @AUTOID@,
  ts BIGINT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  source TEXT NOT NULL,
  server_slug TEXT,
  tool TEXT,
  duration_ms INTEGER,
  outcome TEXT NOT NULL,
  error TEXT,
  args TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit(user_id, ts);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
`;

/**
 * Additive migrations for databases created by an older version: [table, column, definition].
 * (CREATE TABLE IF NOT EXISTS never alters an existing table.)
 */
const COLUMNS = [['servers', 'ref', 'TEXT']];
const INDEXES = ['CREATE INDEX IF NOT EXISTS idx_servers_ref ON servers(ref)'];

/** Convert `?` placeholders to Postgres `$n` (the SQL in this code base never contains a literal `?`). */
const toPg = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** @returns {Promise<Database>} */
async function openSqlite(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA.replace('@AUTOID@', 'INTEGER PRIMARY KEY AUTOINCREMENT'));
  for (const [table, column, def] of COLUMNS) {
    if (
      !raw
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === column)
    )
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  for (const sql of INDEXES) raw.exec(sql);
  return {
    dialect: 'sqlite',
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    async close() {
      raw.close();
    },
  };
}

/** @returns {Promise<Database>} */
async function openPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, Number); // BIGINT / COUNT(*) arrive as numbers, not strings
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Several replicas may start at once: serialise schema creation with an advisory lock.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(SCHEMA.replace('@AUTOID@', 'BIGSERIAL PRIMARY KEY'));
    for (const [table, column, def] of COLUMNS) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
    for (const sql of INDEXES) await client.query(sql);
    await client.query('SELECT pg_advisory_unlock(727274)');
  } finally {
    client.release();
  }
  return {
    dialect: 'postgres',
    async get(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows[0];
    },
    async all(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows;
    },
    async run(sql, params = []) {
      const r = await pool.query(toPg(sql), params);
      return { changes: r.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Open the database described by the configuration.
 * @param {{databaseUrl?: string, dbPath: string}} cfg
 * @typedef {{dialect: 'sqlite'|'postgres', get: Function, all: Function, run: Function, close: Function}} Database
 */
export function openDb(cfg) {
  return cfg.databaseUrl ? openPostgres(cfg.databaseUrl) : openSqlite(cfg.dbPath);
}
