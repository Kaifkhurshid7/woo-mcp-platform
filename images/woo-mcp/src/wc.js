// Minimal WooCommerce REST API (wc/v3) client.
//
// Uses node:http/https directly (not fetch) because inside the cluster we reach WordPress
// via its Service DNS name but may need to present the store's public Host header, and
// undici's fetch does not let you override Host.
import http from 'node:http';
import https from 'node:https';

export class WcError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'WcError';
    this.status = status;
    this.code = code;
  }
}

export function createWcClient({ baseUrl, consumerKey, consumerSecret, hostHeader, timeoutMs = 15000 }) {
  if (!baseUrl) throw new Error('WOO_BASE_URL is required');
  if (!consumerKey || !consumerSecret) throw new Error('WOO_CONSUMER_KEY and WOO_CONSUMER_SECRET are required');
  const base = new URL(baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  const auth = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  function request(method, path, { query, body } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${base.pathname.replace(/\/$/, '')}/wp-json/wc/v3${path}`, base);
      for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
      const payload = body ? JSON.stringify(body) : undefined;
      const headers = {
        Authorization: auth,
        Accept: 'application/json',
        // WooCommerce only accepts consumer-key Basic auth on requests WordPress considers
        // HTTPS. In-cluster traffic is plain HTTP, so we tell WordPress (which maps this
        // header in wp-config.php) that TLS was terminated upstream. See docs/ARCHITECTURE.md.
        'X-Forwarded-Proto': 'https',
      };
      if (hostHeader) headers.Host = hostHeader;
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = lib.request(
        { method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              return reject(new WcError(`WooCommerce returned non-JSON (HTTP ${res.statusCode})`, { status: res.statusCode }));
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              return resolve({ data: json, headers: res.headers });
            }
            const msg = json?.message || `HTTP ${res.statusCode}`;
            reject(new WcError(`WooCommerce error: ${msg}`, { status: res.statusCode, code: json?.code }));
          });
        },
      );
      req.on('timeout', () => req.destroy(new WcError(`WooCommerce request timed out after ${timeoutMs}ms`)));
      req.on('error', (e) => reject(e instanceof WcError ? e : new WcError(`Cannot reach WooCommerce: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
  };
}
