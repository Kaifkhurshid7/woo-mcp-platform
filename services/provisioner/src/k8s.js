/**
 * Minimal Kubernetes API client (in-cluster, no dependencies). Only the calls the provisioner needs.
 * State is kept in Kubernetes itself (namespace labels and annotations), so a restarted provisioner
 * recovers by reading the cluster.
 */
import fs from 'node:fs';
import https from 'node:https';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

export class K8sError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @returns {ReturnType<typeof createK8s>} */
export function createK8s() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || '443';
  const ca = fs.existsSync(`${SA}/ca.crt`) ? fs.readFileSync(`${SA}/ca.crt`) : undefined;

  /** Raw request; the token is re-read every time because Kubernetes rotates it. */
  function request(method, path, body, contentType = 'application/json') {
    const token = fs.readFileSync(`${SA}/token`, 'utf8').trim();
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          port,
          method,
          path,
          ca,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': contentType } : {}) },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) return reject(new K8sError(res.statusCode, json.message || `HTTP ${res.statusCode}`));
            resolve(json);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Kubernetes API timeout')));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const notFoundAsNull = (p) => p.catch((e) => (e.status === 404 ? null : Promise.reject(e)));

  return {
    getNamespace: (name) => notFoundAsNull(request('GET', `/api/v1/namespaces/${name}`)),
    listNamespaces: async (labelSelector) =>
      (await request('GET', `/api/v1/namespaces?labelSelector=${encodeURIComponent(labelSelector)}`)).items,
    createNamespace: (obj) => request('POST', '/api/v1/namespaces', obj),
    /** Merge labels/annotations (a `null` value removes a key). */
    patchNamespace: (name, { labels, annotations }) =>
      request(
        'PATCH',
        `/api/v1/namespaces/${name}`,
        { metadata: { ...(labels && { labels }), ...(annotations && { annotations }) } },
        'application/merge-patch+json',
      ),
    deleteNamespace: (name) => notFoundAsNull(request('DELETE', `/api/v1/namespaces/${name}`)),
    getSecret: (ns, name) => notFoundAsNull(request('GET', `/api/v1/namespaces/${ns}/secrets/${name}`)),
    ping: () => request('GET', '/version'),
  };
}
