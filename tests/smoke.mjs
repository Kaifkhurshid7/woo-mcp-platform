// Smoke test against a RUNNING deployment (local k3d or the VPS). Needs Node 22 and no extra packages
// beyond tests/node_modules (run `npm install` in tests/ once).
//
//   GATEWAY_URL=http://dash.localtest.me:8080 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... node tests/smoke.mjs
//
// It signs in as admin, checks the three upstreams, mints a temporary key, calls tools through the
// public MCP endpoint (including one workflow across two servers), then revokes the key again.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.env.GATEWAY_URL || '').replace(/\/$/, '');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!base || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set GATEWAY_URL, ADMIN_EMAIL and ADMIN_PASSWORD');
  process.exit(2);
}
const step = (m) => console.log(`\n== ${m}`);
const ok = (m) => console.log(`   ok  ${m}`);
const text = (r) => r.content.map((c) => c.text).join('\n');

async function api(method, path, body, cookie) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

step('sign in as admin');
const login = await api('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.json)}`);
ok('signed in');

step('registered servers');
let servers;
for (let i = 0; i < 30; i++) {
  servers = (await api('GET', '/servers', null, login.cookie)).json.servers;
  if (servers.length >= 3 && servers.every((s) => s.status === 'connected')) break;
  await new Promise((r) => setTimeout(r, 2000));
}
for (const s of servers) console.log(`   ${s.status.padEnd(11)} ${s.slug.padEnd(8)} ${s.tools.length} tools`);
assert.ok(servers.length >= 3, 'expected at least 3 upstream servers');
assert.equal(servers[0].slug, 'woo', 'woo should be the first registered server');
assert.ok(servers.every((s) => s.status === 'connected'), 'every server should be connected');
ok('woo, notes and utils are connected');

step('temporary key + MCP calls through the gateway');
const key = (await api('POST', '/keys', { name: 'smoke-test' }, login.cookie)).json;
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key.key}` } } }));
const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of ['woo__list_products', 'woo__create_product', 'woo__list_orders', 'woo__get_order', 'woo__update_order_status', 'notes__ping', 'utils__ping']) assert.ok(names.includes(n), `missing tool ${n}`);
ok(`${names.length} tools listed`);
const created = await client.callTool({ name: 'woo__create_product', arguments: { name: `Smoke test product ${Date.now()}`, regular_price: 10, status: 'draft' } });
assert.ok(!created.isError, text(created));
const product = JSON.parse(text(created)).created;
ok(`created draft product #${product.id} through the store's REST API`);
const orders = await client.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } });
assert.ok(!orders.isError, text(orders));
ok(`orders today: ${JSON.parse(text(orders)).count}`);
const tax = JSON.parse(text(await client.callTool({ name: 'utils__calculate', arguments: { expression: `${product.regular_price} * 1.18` } })));
ok(`two-server workflow: price ${product.regular_price} (woo) -> with 18% tax ${tax.result} (utils)`);
await client.close();

step('revoke the temporary key');
await api('DELETE', `/keys/${key.record.id}`, null, login.cookie);
const rejected = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${key.key}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
assert.equal(rejected.status, 401);
ok('revoked key is rejected with HTTP 401');
console.log('\nSMOKE TEST PASSED');
