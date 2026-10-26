// All configuration comes from the environment (Helm renders a ConfigMap + Secret into env).
// Nothing secret has a default here: missing secrets either abort startup or disable the feature.

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env) {
  const cfg = {
    port: int(env.PORT, 8080),
    dbPath: env.DB_PATH || '/data/gateway.db',
    encryptionKey: env.ENCRYPTION_KEY || '',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, true),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),

    callTimeoutMs: int(env.CALL_TIMEOUT_MS, 30000),
    listTimeoutMs: int(env.LIST_TIMEOUT_MS, 5000),
    refreshIntervalMs: int(env.REFRESH_INTERVAL_MS, 10000),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
    allowPrivateUpstreams: bool(env.ALLOW_PRIVATE_UPSTREAMS, true),
    allowLoopbackUpstreams: bool(env.ALLOW_LOOPBACK_UPSTREAMS, false), // development/test only
    maxKeysPerUser: int(env.MAX_KEYS_PER_USER, 10),

    // JSON array: [{ "slug": "woo", "name": "...", "url": "http://...", "credentialEnv": "WOO_MCP_TOKEN" }]
    seedServers: [],

    llm: {
      provider: (env.LLM_PROVIDER || 'none').toLowerCase(), // anthropic | openai | mock | none
      model: env.LLM_MODEL || '',
      baseUrl: (env.LLM_BASE_URL || '').replace(/\/$/, ''),
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
