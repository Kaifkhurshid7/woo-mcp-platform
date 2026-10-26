/**
 * Gateway configuration.
 *
 * Everything comes from the environment (Helm renders a ConfigMap + Secret into env vars).
 * Nothing secret has a default: a missing secret either aborts start-up or disables the feature.
 */

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const trimSlash = (s) => String(s || '').replace(/\/$/, '');

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GatewayConfig}
 */
export function loadConfig(env = process.env) {
  const cfg = {
    // --- HTTP / sessions ---
    port: int(env.PORT, 8080),
    publicUrl: trimSlash(env.PUBLIC_URL),
    trustProxy: bool(env.TRUST_PROXY, true),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),

    // --- storage: DATABASE_URL (Postgres) wins over DB_PATH (SQLite) ---
    databaseUrl: env.DATABASE_URL || '',
    dbPath: env.DB_PATH || '/data/gateway.db',
    encryptionKey: env.ENCRYPTION_KEY || '',

    // --- bootstrap admin ---
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',

    // --- upstream behaviour ---
    callTimeoutMs: int(env.CALL_TIMEOUT_MS, 30000),
    listTimeoutMs: int(env.LIST_TIMEOUT_MS, 5000),
    refreshIntervalMs: int(env.REFRESH_INTERVAL_MS, 10000),
    allowPrivateUpstreams: bool(env.ALLOW_PRIVATE_UPSTREAMS, true),
    allowLoopbackUpstreams: bool(env.ALLOW_LOOPBACK_UPSTREAMS, false), // development/test only

    // --- limits ---
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
    maxKeysPerUser: int(env.MAX_KEYS_PER_USER, 10),

    // --- OAuth (MCP authorization spec) ---
    oauth: {
      enabled: bool(env.OAUTH_ENABLED, true),
      accessTtlSec: int(env.OAUTH_ACCESS_TTL_SEC, 3600),
      refreshTtlSec: int(env.OAUTH_REFRESH_TTL_SEC, 30 * 24 * 3600),
    },

    // --- provisioner (multi-store + hosted MCP servers); empty URL disables the feature ---
    provisionerUrl: trimSlash(env.PROVISIONER_URL),
    internalToken: env.INTERNAL_TOKEN || '',

    // --- many-tools mode: above this many visible tools the chat agent switches to search/execute ---
    chatMaxDirectTools: int(env.CHAT_MAX_DIRECT_TOOLS, 40),

    // JSON array: [{ "slug": "woo", "name": "...", "url": "http://...", "credentialEnv": "WOO_MCP_TOKEN" }]
    seedServers: [],

    llm: {
      provider: (env.LLM_PROVIDER || 'none').toLowerCase(), // anthropic | openai | mock | none
      model: env.LLM_MODEL || '',
      baseUrl: trimSlash(env.LLM_BASE_URL),
      apiKey: env.LLM_API_KEY || '',
      maxSteps: int(env.CHAT_MAX_STEPS, 8),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 60000),
    },
  };

  if (env.SEED_SERVERS) {
    try {
      const parsed = JSON.parse(env.SEED_SERVERS);
      if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
      cfg.seedServers = parsed.map((s) => ({
        ...s,
        credential: s.credentialEnv && env[s.credentialEnv] ? { type: 'bearer', token: env[s.credentialEnv] } : null,
      }));
    } catch (e) {
      throw new Error(`SEED_SERVERS is invalid: ${e.message}`);
    }
  }
  return cfg;
}

/** @typedef {ReturnType<typeof loadConfig>} GatewayConfig */
