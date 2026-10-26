// End-to-end test of the platform logic with real processes (no Kubernetes needed):
//   mock WooCommerce  <-  woo-mcp  <-+
//                         notes-mcp <-+-  gateway  <-  dashboard API (chat) / external MCP client
//                         utils-mcp <-+
// It walks the "definition of done" from the task: two users, chat + external client, revoke,
// disable, kill an upstream, audit attribution, plus timeouts, SSRF and secret-leak checks.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-e2e-'));
const rand = () => crypto.randomBytes(18).toString('hex');
const P = { woo: 19101, wooMcp: 19102, notes: 19103, utils: 19104, slow: 19105, gw: 19100 };
const secrets = {
  consumerKey: `ck_${rand()}`,
  consumerSecret: `cs_${rand()}`,
  wooTok: rand(),
  notesTok: rand(),
  utilsTok: rand(),
  enc: rand(),
  adminPw: `Adm-${rand()}`,
  pwA: `pw-${rand()}`,
  pwB: `pw-${rand()}`,
};
const procs = [];
let pgContainer = null;
let passed = 0;
const step = (msg) => console.log(`\n== ${msg}`);
const ok = (msg) => (passed++, console.log(`   ok  ${msg}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.name = name;
  p.logs = '';
  p.stdout.on('data', (d) => (p.logs += d));
  p.stderr.on('data', (d) => (p.logs += d));
  procs.push(p);
  return p;
}
const waitHttp = async (url, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${url}`);
};

// A deliberately misbehaving MCP server: lists a tool instantly but never answers tools/call.
function startSlowServer() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST') return res.writeHead(405).end();
      const msg = JSON.parse(body || '{}');
      const reply = (result) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize')
        return reply({
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'slow', version: '1' },
        });
      if (msg.method === 'tools/list')
        return reply({ tools: [{ name: 'hang', description: 'never returns', inputSchema: { type: 'object', properties: {} } }] });
      if (msg.method === 'tools/call') return; // hang forever
      res.writeHead(202).end();
    });
  });
  return new Promise((r) => srv.listen(P.slow, () => r(srv)));
}

const gw = `http://127.0.0.1:${P.gw}`;
async function api(method, url, body, cookie) {
  const res = await fetch(`${gw}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}
const login = async (email, password) => {
  const r = await api('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
};
async function mcp(key) {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gw}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return client;
}
const text = (r) => r.content.map((c) => c.text).join('\n');

async function startPostgres() {
  // E2E_POSTGRES=1 runs the whole test against Postgres (the back end used for multi-replica installs).
  const name = `e2e-pg-${process.pid}`;
  await new Promise((resolve, reject) => {
    const p = spawn('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=e2e',
      '-p',
      '55432:5432',
      'postgres:16-alpine',
    ]);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('could not start postgres'))));
  });
  pgContainer = name;
  for (let i = 0; i < 60; i++) {
    const ready = await new Promise((r) => spawn('docker', ['exec', name, 'pg_isready', '-U', 'postgres']).on('exit', (c) => r(c === 0)));
    if (ready) return 'postgres://postgres:e2e@127.0.0.1:55432/postgres';
    await sleep(500);
  }
  throw new Error('postgres did not become ready');
}

async function main() {
  const databaseUrl = process.env.E2E_POSTGRES ? await startPostgres() : '';
  step('start fake store, upstream MCP servers and the gateway');
  start('mock-woo', 'node', [`${root}/tests/mock-woo.mjs`], {
    PORT: P.woo,
    WOO_CONSUMER_KEY: secrets.consumerKey,
    WOO_CONSUMER_SECRET: secrets.consumerSecret,
  });
  start('woo-mcp', 'node', [`${root}/services/woo-mcp/src/server.js`], {
    PORT: P.wooMcp,
    MCP_AUTH_TOKEN: secrets.wooTok,
    WOO_BASE_URL: `http://127.0.0.1:${P.woo}`,
    WOO_CONSUMER_KEY: secrets.consumerKey,
    WOO_CONSUMER_SECRET: secrets.consumerSecret,
    STORE_TIMEZONE: 'Asia/Calcutta',
  });
  start('notes', 'node', [`${root}/services/demo-mcp/src/server.js`], { PORT: P.notes, KIND: 'notes', MCP_AUTH_TOKEN: secrets.notesTok });
  start('utils', 'node', [`${root}/services/demo-mcp/src/server.js`], { PORT: P.utils, KIND: 'utils', MCP_AUTH_TOKEN: secrets.utilsTok });
  const slow = await startSlowServer();
  const dbPath = path.join(tmp, 'gateway.db');
  const seed = JSON.stringify([
    { slug: 'woo', name: 'WooCommerce store', url: `http://127.0.0.1:${P.wooMcp}/mcp`, credentialEnv: 'T_WOO' },
    { slug: 'notes', name: 'Team notes', url: `http://127.0.0.1:${P.notes}/mcp`, credentialEnv: 'T_NOTES' },
    { slug: 'utils', name: 'Utilities', url: `http://127.0.0.1:${P.utils}/mcp`, credentialEnv: 'T_UTILS' },
  ]);
  start('gateway', 'node', [`${root}/services/gateway/src/index.js`], {
    PORT: P.gw,
    DB_PATH: dbPath,
    DATABASE_URL: databaseUrl,
    ENCRYPTION_KEY: secrets.enc,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: secrets.adminPw,
    SEED_SERVERS: seed,
    T_WOO: secrets.wooTok,
    T_NOTES: secrets.notesTok,
    T_UTILS: secrets.utilsTok,
    LLM_PROVIDER: 'mock',
    REFRESH_INTERVAL_MS: '1000',
    LIST_TIMEOUT_MS: '1500',
    CALL_TIMEOUT_MS: '2000',
    ALLOW_LOOPBACK_UPSTREAMS: 'true',
    NODE_NO_WARNINGS: '1',
  });
  await waitHttp(`http://127.0.0.1:${P.gw}/readyz`);
  ok('gateway is ready');

  step('admin: dashboard shows the seeded servers, all connected, woo first');
  const adminCookie = await login('admin@example.com', secrets.adminPw);
  let servers;
  for (let i = 0; i < 40; i++) {
    servers = (await api('GET', '/api/servers', null, adminCookie)).json.servers;
    if (servers.length === 3 && servers.every((s) => s.status === 'connected')) break;
    await sleep(250);
  }
  assert.deepEqual(
    servers.map((s) => s.slug),
    ['woo', 'notes', 'utils'],
  );
  assert.ok(servers.every((s) => s.status === 'connected'));
  assert.ok(servers[0].tools.map((t) => t.name).includes('create_product'));
  assert.ok(servers[0].tools.length >= 5);
  ok(`woo registered first with ${servers[0].tools.length} tools; notes and utils connected`);
  assert.ok(
    servers.every((s) => s.hasCredential),
    'credentials are stored',
  );

  step('admin: invite two members, they accept and create their own keys');
  const inviteA = (await api('POST', '/api/users', { email: 'a@example.com', name: 'User A', role: 'member' }, adminCookie)).json;
  const inviteB = (await api('POST', '/api/users', { email: 'b@example.com', name: 'User B', role: 'member' }, adminCookie)).json;
  assert.ok(inviteA.inviteToken && inviteB.inviteToken);
  const accA = await api('POST', '/api/auth/accept-invite', { token: inviteA.inviteToken, password: secrets.pwA, name: 'User A' });
  const accB = await api('POST', '/api/auth/accept-invite', { token: inviteB.inviteToken, password: secrets.pwB, name: 'User B' });
  assert.equal(accA.status, 200);
  assert.equal(
    (await api('POST', '/api/auth/accept-invite', { token: inviteA.inviteToken, password: secrets.pwA })).status,
    404,
    'invite is single-use',
  );
  const cookieA = accA.setCookie.split(';')[0];
  const cookieB = accB.setCookie.split(';')[0];
  const keyA = (await api('POST', '/api/keys', { name: 'laptop' }, cookieA)).json;
  const keyB = (await api('POST', '/api/keys', { name: 'cursor' }, cookieB)).json;
  assert.match(keyA.key, /^gw_/);
  assert.equal((await api('GET', '/api/keys', null, cookieA)).json.keys.length, 1);
  assert.ok(!JSON.stringify((await api('GET', '/api/keys', null, cookieA)).json).includes(keyA.key), 'key is shown only once');
  ok('both members have their own keys');

  step('member cannot manage servers/users and never sees upstream URLs or credentials');
  assert.equal((await api('POST', '/api/servers', { name: 'x', url: 'http://10.0.0.1/mcp' }, cookieA)).status, 403);
  assert.equal((await api('GET', '/api/users', null, cookieA)).status, 403);
  const memberView = JSON.stringify((await api('GET', '/api/servers', null, cookieA)).json);
  for (const t of [secrets.wooTok, secrets.notesTok, secrets.utilsTok, '127.0.0.1'])
    assert.ok(!memberView.includes(t), `member view leaks ${t}`);
  const adminView = JSON.stringify((await api('GET', '/api/servers', null, adminCookie)).json);
  for (const t of [secrets.wooTok, secrets.notesTok, secrets.utilsTok]) assert.ok(!adminView.includes(t), 'admin API leaks a credential');
  ok('no credential is ever returned by the API');

  step("chat agent as user A: create a product, then ask about today's orders");
  let r = await api('POST', '/api/chat', { message: 'Please create product named Coffee Mug priced 12.50' }, cookieA);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.toolCalls[0].name, 'woo__create_product');
  assert.ok(!r.json.toolCalls[0].isError, r.json.toolCalls[0].output);
  const prod = await (
    await fetch(`http://127.0.0.1:${P.woo}/__test/order`, {
      method: 'POST',
      body: JSON.stringify({ qty: 2, first: 'Asha', last: 'Verma' }),
    })
  ).json();
  ok(`product created through the chat agent; shopper order #${prod.id} placed on the "storefront"`);
  r = await api('POST', '/api/chat', { message: 'What orders came in today?' }, cookieA);
  assert.equal(r.json.toolCalls[0].name, 'woo__list_orders');
  assert.ok(r.json.toolCalls[0].output.includes(String(prod.id)), 'order returned');
  assert.ok(r.json.reply.includes(String(prod.id)));
  ok('agent returned the new order and showed which tool it called');

  step('external MCP client as user B: sees all tools, asks the same question, uses two servers');
  const b = await mcp(keyB.key);
  const names = (await b.listTools()).tools.map((t) => t.name);
  for (const n of [
    'woo__list_products',
    'woo__create_product',
    'woo__list_orders',
    'woo__get_order',
    'woo__update_order_status',
    'notes__ping',
    'utils__ping',
    'utils__calculate',
  ])
    assert.ok(names.includes(n), `missing ${n}`);
  assert.equal(new Set(names).size, names.length);
  ok(`${names.length} tools listed; same-named "ping" tools are notes__ping and utils__ping`);
  const orders = JSON.parse(text(await b.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } })));
  assert.equal(orders.orders[0].id, prod.id);
  ok('B got the same order through the gateway');
  const price = JSON.parse(text(await b.callTool({ name: 'woo__list_products', arguments: { search: 'Coffee' } }))).products[0].price;
  const gst = JSON.parse(text(await b.callTool({ name: 'utils__calculate', arguments: { expression: `${price} * 1.18` } })));
  assert.equal(gst.result, 14.75);
  const note = await b.callTool({
    name: 'notes__add_note',
    arguments: { title: 'Coffee Mug price', body: `${price} + 18% GST = ${gst.result}` },
  });
  assert.ok(!note.isError);
  ok('one workflow used woo + utils + notes (three upstream servers)');
  const upd = JSON.parse(text(await b.callTool({ name: 'woo__update_order_status', arguments: { id: prod.id, status: 'completed' } })));
  assert.equal(upd.updated.status, 'completed');
  const bad = await b.callTool({ name: 'woo__get_order', arguments: { id: 99999 } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Invalid ID/);
  ok('tool errors from the store are passed through clearly');
  await b.close();

  step("revoke user B's key: next call is rejected");
  const keyBRecord = (await api('GET', '/api/keys?all=1', null, adminCookie)).json.keys.find((k) => k.owner === 'b@example.com');
  assert.equal((await api('DELETE', `/api/keys/${keyBRecord.id}`, null, adminCookie)).status, 200);
  await assert.rejects(() => mcp(keyB.key), /401|revoked|Unauthorized|HTTP/i);
  const rawRejected = await fetch(`${gw}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${keyB.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(rawRejected.status, 401);
  assert.equal((await rawRejected.json()).error.message, 'This API key has been revoked.');
  ok('HTTP 401 for the revoked key');

  step('slow upstream: listing stays fast, a hanging call times out with a clear error');
  const created = await api('POST', '/api/servers', { name: 'Slowpoke', url: `http://127.0.0.1:${P.slow}/mcp` }, adminCookie);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.server.status, 'connected');
  const keyB2 = (await api('POST', '/api/keys', { name: 'cursor-2', userId: accB.json.user.id }, adminCookie)).json.key;
  const c = await mcp(keyB2);
  const hang = c.callTool({ name: 'slowpoke__hang', arguments: {} });
  const t0 = Date.now();
  const listed = await c.listTools();
  assert.ok(Date.now() - t0 < 1000, 'tool listing is not blocked by the hanging call');
  const w = await c.callTool({ name: 'woo__list_products', arguments: {} });
  assert.ok(!w.isError, 'other servers keep working');
  const hung = await hang;
  assert.equal(hung.isError, true);
  assert.match(text(hung), /did not answer in time/);
  assert.ok(Date.now() - t0 < 4000, 'timeout fired at the configured 2s');
  ok(`${listed.tools.length} tools still listed; hanging call failed with: ${text(hung).slice(0, 90)}…`);

  step('disable an upstream: its tools disappear from the chat agent and from the external client');
  const utils = servers.find((s) => s.slug === 'utils');
  const dis = await api('PUT', `/api/servers/${utils.id}`, { enabled: false }, adminCookie);
  assert.equal(dis.json.server.status, 'disabled');
  const afterDisable = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(!afterDisable.some((n) => n.startsWith('utils__')));
  assert.ok(afterDisable.some((n) => n.startsWith('woo__')));
  const callDisabled = await c.callTool({ name: 'utils__ping', arguments: {} });
  assert.equal(callDisabled.isError, true);
  r = await api('POST', '/api/chat', { message: 'ping everything' }, cookieA);
  assert.ok(r.json.toolCalls.every((t) => !t.name.startsWith('utils__')) && r.json.toolCalls.some((t) => t.name === 'notes__ping'));
  ok('utils tools gone for both clients; calling one directly is rejected');
  await api('PUT', `/api/servers/${utils.id}`, { enabled: true }, adminCookie);

  step('kill one upstream pod: the others keep working and the dashboard shows it unreachable');
  procs.find((p) => p.name === 'notes').kill('SIGKILL');
  const killedCall = await c.callTool({ name: 'notes__ping', arguments: {} });
  assert.equal(killedCall.isError, true);
  assert.match(text(killedCall), /notes.*(failed|did not answer).*Other servers are unaffected/);
  assert.ok(!(await c.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } })).isError);
  assert.ok(!(await c.callTool({ name: 'utils__ping', arguments: {} })).isError);
  let notesView;
  for (let i = 0; i < 20; i++) {
    notesView = (await api('GET', '/api/servers', null, adminCookie)).json.servers.find((s) => s.slug === 'notes');
    if (notesView.status === 'unreachable') break;
    await sleep(250);
  }
  assert.equal(notesView.status, 'unreachable');
  assert.match(notesView.error, /connection (refused|closed|reset)/);
  assert.ok(!(await c.listTools()).tools.some((t) => t.name.startsWith('notes__')));
  ok(`notes is "${notesView.status}" (${notesView.error}); woo and utils unaffected`);
  await c.close();

  step('many tools: /mcp/search exposes three meta-tools; the real call is still routed, permissioned and audited');
  const keyB3 = (await api('POST', '/api/keys', { name: 'search-client', userId: accB.json.user.id }, adminCookie)).json.key;
  const sc = new Client({ name: 'e2e-search', version: '1' });
  await sc.connect(
    new StreamableHTTPClientTransport(new URL(`${gw}/mcp/search`), { requestInit: { headers: { Authorization: `Bearer ${keyB3}` } } }),
  );
  const metaNames = (await sc.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(metaNames, ['call_tool', 'describe_tool', 'search_tools']);
  const found = JSON.parse(text(await sc.callTool({ name: 'search_tools', arguments: { query: 'list orders' } })));
  assert.equal(found.results[0].name, 'woo__list_orders', 'best match first');
  const described = JSON.parse(text(await sc.callTool({ name: 'describe_tool', arguments: { name: 'woo__list_orders' } })));
  assert.ok(described.inputSchema, 'schema is returned on demand');
  const viaSearch = await sc.callTool({ name: 'call_tool', arguments: { name: 'woo__list_orders', arguments: {} } });
  assert.ok(!viaSearch.isError);
  const denied = await sc.callTool({ name: 'call_tool', arguments: { name: 'woo__create_product', arguments: { name: 'x', price: '1' } } });
  assert.equal(denied.isError, true, 'members cannot create products through search/execute either');
  await sc.close();
  ok('search_tools finds woo__list_orders first; call_tool executes it and respects permissions');

  step('OAuth (MCP authorization spec): discovery, dynamic registration, PKCE browser login, refresh rotation, revoke');
  const rpc = (token) =>
    fetch(`${gw}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  const unauth = await rpc();
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="[^"]*oauth-protected-resource"/);
  const prm = await (await fetch(`${gw}/.well-known/oauth-protected-resource`)).json();
  const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  const post = (url, body, form) =>
    fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  const redirectUri = 'http://127.0.0.1:8765/callback';
  assert.equal(
    (await post(asm.registration_endpoint, { client_name: 'evil', redirect_uris: ['javascript:alert(1)'] })).status,
    400,
    'dangerous redirect URI refused',
  );
  const reg = await post(asm.registration_endpoint, { client_name: 'e2e client', redirect_uris: [redirectUri] });
  assert.equal(reg.status, 201);
  const { client_id: clientId } = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authParams = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  };
  const loginPage = await fetch(`${asm.authorization_endpoint}?${new URLSearchParams(authParams)}`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Sign in &amp; allow/);
  const badLogin = await post(
    asm.authorization_endpoint,
    { ...authParams, decision: 'allow', email: 'a@example.com', password: 'wrong-password' },
    true,
  );
  assert.equal(badLogin.status, 401);
  const getCode = async () => {
    const r = await post(
      asm.authorization_endpoint,
      { ...authParams, decision: 'allow', email: 'a@example.com', password: secrets.pwA },
      true,
    );
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.searchParams.get('state'), 'xyz');
    return loc.searchParams.get('code');
  };
  const wrongVerifier = await post(
    asm.token_endpoint,
    {
      grant_type: 'authorization_code',
      code: await getCode(),
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: 'not-the-verifier',
    },
    true,
  );
  assert.equal(wrongVerifier.status, 400, 'PKCE verifier is enforced');
  const exchange = {
    grant_type: 'authorization_code',
    code: await getCode(),
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  const tok = await (await post(asm.token_endpoint, exchange, true)).json();
  assert.match(tok.access_token, /^gwo_/);
  assert.equal((await post(asm.token_endpoint, exchange, true)).status, 400, 'authorization codes are single-use');
  const oc = await mcp(tok.access_token);
  assert.ok((await oc.listTools()).tools.some((t) => t.name === 'woo__list_orders'));
  assert.ok(!(await oc.callTool({ name: 'woo__list_orders', arguments: {} })).isError);
  await oc.close();
  const refreshed = await (
    await post(asm.token_endpoint, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId }, true)
  ).json();
  assert.match(refreshed.access_token, /^gwo_/);
  assert.equal(
    (await post(asm.token_endpoint, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId }, true)).status,
    400,
    'old refresh token is rotated out',
  );
  assert.equal((await api('GET', '/api/oauth/grants', null, cookieA)).json.grants.length, 1);
  assert.equal((await api('DELETE', `/api/oauth/grants/${clientId}`, null, cookieA)).status, 200);
  assert.equal((await rpc(refreshed.access_token)).status, 401, 'revoking the grant kills its tokens');
  ok('browser-style PKCE login works; codes are single-use; refresh rotates; revoking the connection ends access');

  step('audit log: every call is there, attributed to the right user');
  const audit = (await api('GET', '/api/audit?limit=500', null, adminCookie)).json.entries;
  const by = (u, f) => audit.filter((e) => e.user === u && f(e));
  assert.ok(by('a@example.com', (e) => e.source === 'chat' && e.tool === 'create_product' && e.outcome === 'success').length === 1);
  assert.ok(by('a@example.com', (e) => e.source === 'chat' && e.tool === 'list_orders').length === 1);
  assert.ok(
    by(
      'b@example.com',
      (e) => e.source === 'mcp' && e.server === 'woo' && e.tool === 'list_orders' && e.outcome === 'success' && e.durationMs >= 0,
    ).length >= 1,
  );
  assert.ok(by('b@example.com', (e) => e.tool === '(authentication)' && e.outcome === 'rejected' && /revoked/.test(e.error)).length >= 1);
  assert.ok(by('b@example.com', (e) => e.server === 'slowpoke' && e.outcome === 'timeout').length === 1);
  assert.ok(by('b@example.com', (e) => e.server === 'notes' && e.outcome === 'unreachable').length === 1);
  assert.ok(by('b@example.com', (e) => e.server === 'woo' && e.tool === 'get_order' && e.outcome === 'error').length === 1);
  assert.ok(
    audit.every((e) => e.user !== 'admin@example.com' || e.source),
    'admin entries have a source',
  );
  const own = (await api('GET', '/api/audit', null, cookieA)).json.entries;
  assert.ok(own.length > 0 && own.every((e) => e.user === 'a@example.com'), 'members only see their own entries');
  ok(`${audit.length} audit entries; chat calls attributed to A, MCP calls to B, revoked key and timeout recorded`);

  step('security: SSRF guard, secrets at rest, metrics');
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'http://user:pw@example.com/mcp',
  ]) {
    const res = await api('POST', '/api/servers', { name: 'evil', url }, adminCookie);
    assert.equal(res.status, 400, `${url} should be rejected`);
  }
  if (!databaseUrl) {
    const dbBytes = fs.readFileSync(dbPath);
    for (const t of [secrets.wooTok, secrets.notesTok, secrets.utilsTok, keyA.key, secrets.pwA])
      assert.ok(!dbBytes.includes(t), 'a secret is stored in plaintext in the database');
  }
  ok('metadata/file URLs rejected; no token, key or password is stored in plaintext');
  const metrics = await (await fetch(`${gw}/metrics`)).text();
  assert.match(metrics, /gateway_tool_calls_total\{server="woo",outcome="success",source="mcp"\}/);
  assert.match(metrics, /gateway_upstream_up\{server="notes"\} 0/);
  ok('Prometheus metrics expose calls, outcomes and upstream health');

  slow.close();
  console.log(`\nALL ${passed} CHECKS PASSED`);
}

main()
  .catch((e) => {
    console.error('\nFAILED:', e);
    for (const p of procs) if (p.name === 'gateway') console.error(`--- gateway logs ---\n${p.logs.slice(-3000)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill('SIGKILL');
    if (pgContainer) spawn('docker', ['rm', '-f', pgContainer], { stdio: 'ignore' });
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the SQLite file for a moment; the OS temp dir is cleaned up later */
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
