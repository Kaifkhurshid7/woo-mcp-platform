// Scaling demo: with Postgres and 2+ gateway replicas, MCP sessions (stateless) and shared state keep working
// no matter which pod answers.   node tests/replicas-demo.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const NS = process.env.NAMESPACE || 'platform';
const gw = (process.env.GATEWAY_URL || 'http://dash.localtest.me:8080').replace(/\/$/, '');
const kubectl = (...a) => execFileSync('kubectl', a, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = Buffer.from(
  kubectl('-n', NS, 'get', 'secret', 'shop-secrets', '-o', 'jsonpath={.data.gateway-admin-password}'),
  'base64',
).toString();

const pods = kubectl('-n', NS, 'get', 'pod', '-l', 'app.kubernetes.io/name=gateway', '-o', 'jsonpath={.items[*].metadata.name}').split(' ');
assert.ok(pods.length >= 2, `need 2+ gateway pods, found ${pods.length}`);
console.log(`== ${pods.length} gateway replicas: ${pods.join(', ')}`);

/** Total tool calls this pod has served, from its Prometheus endpoint. */
const callsServed = (pod) => {
  const m = kubectl(
    '-n',
    NS,
    'exec',
    pod,
    '--',
    'node',
    '-e',
    "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(t=>console.log(t))",
  );
  return [...m.matchAll(/gateway_tool_calls_total\{[^}]*\} (\d+)/g)].reduce((n, x) => n + Number(x[1]), 0);
};

async function api(method, path, body, cookie) {
  const res = await fetch(`${gw}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

const before = pods.map(callsServed);
const admin = (await api('POST', '/auth/login', { email: 'admin@example.com', password: pw })).cookie;
const key = (await api('POST', '/keys', { name: 'replica-test' }, admin)).json;
console.log('== a session and a key created through one pod work on every pod (shared Postgres)');
for (let i = 0; i < 10; i++) assert.equal((await api('GET', '/servers', null, admin)).status, 200);
console.log('   ok  10 dashboard requests with one session cookie, spread over the pods');

const client = new Client({ name: 'replicas', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${gw}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key.key}` } } }),
);
for (let i = 0; i < 24; i++) assert.ok(!(await client.callTool({ name: 'utils__calculate', arguments: { expression: `${i}+1` } })).isError);
await client.close();
const after = pods.map(callsServed);
const served = after.map((n, i) => n - before[i]);
console.log(`   ok  24 MCP calls through the Ingress; per-pod counts: ${pods.map((p, i) => `${p.slice(-5)}=${served[i]}`).join(', ')}`);
assert.ok(
  served.every((n) => n > 0),
  'every replica should have served some calls',
);

console.log('== revoking the key (via whichever pod) is effective on all pods immediately');
await api('DELETE', `/keys/${key.record.id}`, null, admin);
let rejected = 0;
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${gw}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (r.status === 401) rejected++;
}
assert.equal(rejected, 12);
console.log('   ok  12/12 requests rejected, whichever pod answered');

console.log('== disabling an upstream on one pod hides its tools on the other within seconds');
const servers = (await api('GET', '/servers', null, admin)).json.servers;
const utils = servers.find((s) => s.slug === 'utils');
await api('PUT', `/servers/${utils.id}`, { enabled: false }, admin);
await sleep(3000);
const k2 = (await api('POST', '/keys', { name: 'replica-test-2' }, admin)).json;
for (let i = 0; i < 6; i++) {
  const c = new Client({ name: 'r2', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${gw}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${k2.key}` } } }),
  );
  assert.ok(!(await c.listTools()).tools.some((t) => t.name.startsWith('utils__')), 'utils tools still visible on some pod');
  await c.close();
}
await api('PUT', `/servers/${utils.id}`, { enabled: true }, admin);
await api('DELETE', `/keys/${k2.record.id}`, null, admin);
console.log('   ok  utils tools gone for every request, whichever pod served it');

console.log('== a pod can die without losing anything');
kubectl('-n', NS, 'delete', 'pod', pods[0], '--wait=false');
for (let i = 0; i < 8; i++) assert.equal((await api('GET', '/auth/me', null, admin)).status, 200);
console.log('   ok  session still valid while one replica restarts (traffic served by the other)');
console.log('\nREPLICAS DEMO COMPLETE');
