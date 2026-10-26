/** Thin wrapper around the `helm` CLI. Install/upgrade is idempotent, which is what makes retries safe. */
import { spawn } from 'node:child_process';

export class HelmError extends Error {}

/**
 * Run helm and resolve with its stdout. Rejects with the tail of stderr on failure.
 * @param {string[]} args
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 */
export function runHelm(args, { signal, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('helm', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...process.env, HELM_CACHE_HOME: '/tmp/helm/cache', HELM_CONFIG_HOME: '/tmp/helm/config', HELM_DATA_HOME: '/tmp/helm/data' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.name === 'AbortError' ? new HelmError('provisioning was cancelled') : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new HelmError(`helm ${args[0]} failed: ${(err || out).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`));
    });
  });
}
