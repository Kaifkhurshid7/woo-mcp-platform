/** Provisioner configuration, read from the environment (rendered by the Helm chart). */

const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const json = (v, d) => {
  try {
    return v ? JSON.parse(v) : d;
  } catch {
    throw new Error('STORE_VALUES / HOSTED_VALUES must be valid JSON');
  }
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    internalToken: env.INTERNAL_TOKEN || '',
    gatewayUrl: (env.GATEWAY_URL || '').replace(/\/$/, ''),
    platformNamespace: env.PLATFORM_NAMESPACE || 'platform',
    chartPath: env.PLATFORM_CHART || '/charts/platform',
    hostedChartPath: env.HOSTED_CHART || '/charts/hosted-mcp',
    workDir: env.WORK_DIR || '/tmp/provisioner',

    // stores
    storeDomainSuffix: env.STORE_DOMAIN_SUFFIX || 'stores.localtest.me',
    storeScheme: env.STORE_SCHEME || 'http',
    storePort: env.STORE_PORT || '',
    maxStoresPerUser: int(env.MAX_STORES_PER_USER, 2),
    maxStoresTotal: int(env.MAX_STORES_TOTAL, 6),
    provisionTimeoutSec: int(env.PROVISION_TIMEOUT_SEC, 600),
    storeValues: json(env.STORE_VALUES, {}),

    // hosted MCP servers
    hostedAllowedRegistries: (env.HOSTED_ALLOWED_REGISTRIES || 'woo-platform/')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hostedMaxServers: int(env.HOSTED_MAX_SERVERS, 5),
    hostedValues: json(env.HOSTED_VALUES, {}),

    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 15000),
  };
}
