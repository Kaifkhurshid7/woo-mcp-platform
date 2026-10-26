// Hosted MCP server demo against the running cluster: an admin deploys a server from a container image,
// its tools appear in the gateway, then it is removed cleanly.   node tests/hosted-demo.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const NS = process.env.NAMESPACE || 'platform';
const gw = (process.env.GATEWAY_URL || 'http://dash.localtest.me:8080').replace(/\/$/, '');
const kubectl = (...a) => execFileSync('kubectl', a, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminPw = Buffer.from(
  kubectl('-n', NS, 'get', 'secret', 'shop-secrets', '-o', 'jsonpath={.data.gateway-admin-password}'),
  'base64',
).toString();

async function api(method, path, body, cookie) {
  const res = await fetch(`${gw}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const until = async (fn, what, ms = 180_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => false);
    if (v) return v;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const admin = (await api('POST', '/auth/login', { email: 'admin@example.com', password: adminPw })).cookie;

console.log('== hosted server: images outside the allowed registries are refused');
const refused = await api('POST', '/hosted', { name: 'Evil', image: 'evil.example.com/miner:latest' }, admin);
assert.equal(refused.status, 400);
console.log(`   ok  ${refused.json.error}`);

console.log('== deploy woo-platform/demo-mcp:dev as a hosted server (own namespace, Secret, limits, NetworkPolicy)');
const created = await api('POST', '/hosted', { name: 'Hosted utils', image: 'woo-platform/demo-mcp:dev', env: { KIND: 'utils' } }, admin);
assert.equal(created.status, 202, JSON.stringify(created.json));
const h = created.json.hosted;
const ready = await until(
  async () => (await api('GET', '/hosted', null, admin)).json.hosted.find((x) => x.id === h.id && x.phase === 'Ready'),
  'hosted Ready',
);
console.log(`   ok  ${ready.name} is ${ready.phase} in namespace ${ready.namespace}`);

const tools = await until(async () => {
  const s = (await api('GET', '/servers', null, admin)).json.servers.find((x) => x.slug === h.slug);
  return s?.status === 'connected' && s.tools;
}, 'hosted tools in the gateway');
console.log(`   ok  registered in the gateway as "${h.slug}" with ${tools.length} tools: ${tools.map((t) => t.exposedName).join(', ')}`);
console.log(
  '   ' +
    kubectl('-n', h.namespace, 'get', 'deploy,svc,secret,networkpolicy,resourcequota', '--no-headers')
      .split('\n')
      .map((l) => l.split(/\s+/)[0])
      .join(', '),
);
const managed = (await api('GET', '/servers', null, admin)).json.servers.find((x) => x.slug === h.slug);
assert.equal((await api('DELETE', `/servers/${managed.id}`, null, admin)).status, 400, 'managed servers cannot be removed directly');

console.log('== delete it: namespace, Secret and tools disappear');
assert.equal((await api('DELETE', `/hosted/${h.id}`, null, admin)).status, 202);
await until(async () => !kubectl('get', 'ns', '--ignore-not-found', h.namespace), 'namespace removal');
await until(async () => !(await api('GET', '/servers', null, admin)).json.servers.some((x) => x.slug === h.slug), 'deregistration');
console.log('   ok  namespace gone and server deregistered');
console.log('\nHOSTED DEMO COMPLETE');
