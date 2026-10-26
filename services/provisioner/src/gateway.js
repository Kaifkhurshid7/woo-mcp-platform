/** Client for the gateway's internal registration API (cluster-internal, bearer-token protected). */

export function createGatewayClient({ gatewayUrl, internalToken }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${gatewayUrl}/internal${path}`, {
      method,
      headers: { authorization: `Bearer ${internalToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `gateway answered HTTP ${res.status}`);
    return json;
  };
  return {
    /** Register (or update) the MCP server of a store / hosted server so its tools appear in the gateway. */
    register: (ref, server) => call('PUT', `/servers/${ref}`, server),
    deregister: (ref) => call('DELETE', `/servers/${ref}`),
    /** @returns {Promise<Array<{ref: string, slug: string, source: string}>>} */
    list: async () => (await call('GET', '/servers')).servers,
  };
}
