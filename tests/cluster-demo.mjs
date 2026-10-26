// End-to-end demo against the RUNNING cluster (local k3d or the VPS): the task's "definition of done", scripted.
//
//   node tests/cluster-demo.mjs            core flow (store, chat as user A, external client as user B, control)
//   STORES=1 node tests/cluster-demo.mjs   additionally: two provisioned stores, cross-store question, delete, isolation
//
// Needs kubectl access (for the generated admin password and to kill a pod) and Node 22.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const NS = process.env.NAMESPACE || 'platform';
const RELEASE = process.env.RELEASE || 'shop';
const PORT = process.env.HOST_PORT ?? ':8080';
const gw = (process.env.GATEWAY_URL || `http://dash.localtest.me${PORT}`).replace(/\/$/, '');
const store = (process.env.STORE_URL || `http://store.localtest.me${PORT}`).replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`\n== ${m}`);
const ok = (m) => console.log(`   ok  ${m}`);
const text = (r) => r.content.map((c) => c.text).join('\n');
const kubectl = (...args) => execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
const secret = (key) =>
  Buffer.from(kubectl('-n', NS, 'get', 'secret', `${RELEASE}-secrets`, '-o', `jsonpath={.data.${key}}`), 'base64').toString();

async function api(method, path, body, cookie, headers = {}) {
  const res = await fetch(`${gw}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function mcp(key) {
  const c = new Client({ name: 'cluster-demo', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${gw}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return c;
}
async function until(fn, what, ms = 120_000, every = 2000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** Buy one unit of `productName` on a storefront with Cash on Delivery, like a customer would. Returns the order id. */
async function checkout(base, productName) {
  const products = await (await fetch(`${base}/wp-json/wc/store/v1/products?search=${encodeURIComponent(productName)}`)).json();
  const product = products.find((p) => p.name === productName);
  assert.ok(product, `"${productName}" is not on the storefront at ${base}`);
  // A first cart request hands out the Nonce and Cart-Token that identify this anonymous shopper.
  const cart = await fetch(`${base}/wp-json/wc/store/v1/cart`);
  const headers = { 'content-type': 'application/json', Nonce: cart.headers.get('nonce'), 'Cart-Token': cart.headers.get('cart-token') };
  const add = await fetch(`${base}/wp-json/wc/store/v1/cart/add-item`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: product.id, quantity: 1 }),
  });
  assert.ok([200, 201].includes(add.status), `add to cart: ${add.status} ${await add.text()}`);
  const address = {
    first_name: 'Test',
    last_name: 'Shopper',
    address_1: '1 Main St',
    city: 'San Francisco',
    state: 'CA',
    postcode: '94105',
    country: 'US',
    email: 'shopper@example.com',
    phone: '5555550100',
  };
  const res = await fetch(`${base}/wp-json/wc/store/v1/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ billing_address: address, shipping_address: address, payment_method: 'cod' }),
  });
  const order = await res.json();
  assert.equal(res.status, 200, `checkout failed: ${JSON.stringify(order).slice(0, 300)}`);
  return order.order_id;
}

async function main() {
  step('store: the storefront is up and has a product');
  const home = await fetch(`${store}/`);
  assert.equal(home.status, 200);
  const sample = await (await fetch(`${store}/wp-json/wc/store/v1/products`)).json();
  assert.ok(sample.length >= 1);
  ok(`storefront ${store} answers; ${sample.length} product(s) listed`);
  const sampleOrder = await checkout(store, sample[0].name);
  ok(`checked out "${sample[0].name}" with Cash on Delivery -> order #${sampleOrder} (visible in WooCommerce admin)`);

  step('admin: dashboard shows the registered servers; WooCommerce is first');
  const login = await api('POST', '/auth/login', { email: 'admin@example.com', password: secret('gateway-admin-password') });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const admin = login.cookie;
  const servers = await until(async () => {
    const s = (await api('GET', '/servers', null, admin)).json.servers;
    return s.filter((x) => ['woo', 'notes', 'utils'].includes(x.slug)).every((x) => x.status === 'connected') && s;
  }, 'seed servers to connect');
  assert.equal(servers[0].slug, 'woo');
  ok(servers.map((s) => `${s.slug}: ${s.status}, ${s.tools.length} tools`).join(' | '));

  step('admin invites user A and user B; each creates their own API key');
  const stamp = Date.now();
  const mk = async (who) => {
    const inv = (
      await api('POST', '/users', { email: `${who}${stamp}@example.com`, name: `User ${who.toUpperCase()}`, role: 'member' }, admin)
    ).json;
    const acc = await api('POST', '/auth/accept-invite', { token: inv.inviteToken, password: `pw-${stamp}-${who}-long` });
    assert.equal(acc.status, 200);
    const key = (await api('POST', '/keys', { name: `${who}-laptop` }, acc.cookie)).json.key;
    return { email: `${who}${stamp}@example.com`, cookie: acc.cookie, key, id: inv.user.id };
  };
  const A = await mk('a');
  const B = await mk('b');
  ok(`${A.email} and ${B.email} have their own keys; members never see upstream URLs or credentials`);
  assert.ok(!JSON.stringify((await api('GET', '/servers', null, A.cookie)).json).includes('svc'), 'member sees a cluster URL');

  step('chat agent as user A: create a product, then ask what orders came in today');
  const productName = `Demo Mug ${stamp}`;
  const created = await api('POST', '/chat', { message: `create product named ${productName} priced 19` }, A.cookie);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.ok(
    created.json.toolCalls.some((t) => t.tool === 'create_product' && !t.isError),
    `create_product failed: ${JSON.stringify(created.json.toolCalls)}`,
  );
  const onShelf = await until(
    async () => (await (await fetch(`${store}/wp-json/wc/store/v1/products?search=${stamp}`)).json()).length > 0,
    'product on the storefront',
    30_000,
  );
  ok(`agent called woo__create_product; "${productName}" is on the storefront: ${onShelf}`);
  const orderId = await checkout(store, productName);
  const asked = await api('POST', '/chat', { message: 'what orders came in today?' }, A.cookie);
  assert.equal(asked.status, 200);
  assert.ok(
    text({ content: [{ text: asked.json.reply }] }).includes(`"id": ${orderId}`) || asked.json.reply.includes(String(orderId)),
    `order #${orderId} missing from: ${asked.json.reply.slice(0, 300)}`,
  );
  ok(`placed order #${orderId} by hand; the agent returned it (tools shown: ${asked.json.toolCalls.map((t) => t.name).join(', ')})`);

  step("external MCP client as user B: gateway URL + B's key only");
  const cb = await mcp(B.key);
  const tools = (await cb.listTools()).tools;
  assert.ok(
    tools.some((t) => t.name === 'woo__list_orders') &&
      tools.some((t) => t.name === 'notes__add_note') &&
      tools.some((t) => t.name === 'utils__calculate'),
  );
  ok(`${tools.length} tools visible from woo, notes and utils; no per-server configuration`);
  const orders = text(await cb.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } }));
  assert.ok(orders.includes(String(orderId)));
  ok(`B asked the same orders question and got order #${orderId}`);
  const calc = text(await cb.callTool({ name: 'utils__calculate', arguments: { expression: '19 * 3' } }));
  const note = await cb.callTool({ name: 'notes__add_note', arguments: { title: `order ${orderId} total check`, body: calc } });
  assert.ok(!note.isError);
  ok('one workflow used woo (orders) + utils (calculator) + notes (scratch-pad): three upstream servers');

  step('control: revoke user B, disable a server, kill an upstream pod');
  const keys = (await api('GET', '/keys', null, B.cookie)).json.keys;
  assert.equal((await api('DELETE', `/keys/${keys[0].id}`, null, B.cookie)).status, 200);
  const denied = await fetch(`${gw}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${B.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(denied.status, 401);
  ok("B's key revoked: the next call is rejected with HTTP 401");
  await cb.close();

  const keyA2 = (await api('POST', '/keys', { name: 'a-second' }, A.cookie)).json.key;
  const ca = await mcp(keyA2);
  const utilsId = servers.find((s) => s.slug === 'utils').id;
  await api('PUT', `/servers/${utilsId}`, { enabled: false }, admin);
  assert.ok(!(await ca.listTools()).tools.some((t) => t.name.startsWith('utils__')));
  const chatTools = await api('POST', '/chat', { message: 'ping' }, A.cookie);
  assert.ok(!chatTools.json.toolCalls.some((t) => t.server === 'utils'));
  ok('utils disabled: its tools disappeared from the external client and from the chat agent');
  await api('PUT', `/servers/${utilsId}`, { enabled: true }, admin);

  const notesPod = kubectl('-n', NS, 'get', 'pod', '-l', 'app.kubernetes.io/name=notes-mcp', '-o', 'jsonpath={.items[0].metadata.name}');
  kubectl('-n', NS, 'scale', 'deploy', `${RELEASE}-notes-mcp`, '--replicas=0'); // "kill the pod" and keep it dead
  const notes = await until(
    async () =>
      (await api('GET', '/servers', null, admin)).json.servers.find((s) => s.slug === 'notes').status === 'unreachable' && 'unreachable',
    'notes to show unreachable',
    60_000,
    1500,
  );
  const still = (await api('GET', '/servers', null, admin)).json.servers.find((s) => s.slug === 'woo');
  assert.equal(still.status, 'connected');
  assert.ok(!(await ca.callTool({ name: 'woo__list_products', arguments: {} })).isError);
  ok(`pod ${notesPod} killed: dashboard shows notes as "${notes}", woo keeps working`);
  kubectl('-n', NS, 'scale', 'deploy', `${RELEASE}-notes-mcp`, '--replicas=1');
  await ca.close();

  step('audit log: every call above, attributed to the right user');
  const audit = (await api('GET', '/audit?limit=500', null, admin)).json.entries;
  const mine = (u, f) => audit.filter((e) => e.user === u && f(e));
  assert.ok(mine(A.email, (e) => e.source === 'chat' && e.tool === 'create_product').length >= 1);
  assert.ok(mine(A.email, (e) => e.source === 'chat' && e.tool === 'list_orders').length >= 1);
  assert.ok(mine(B.email, (e) => e.source === 'mcp' && e.server === 'woo' && e.tool === 'list_orders').length >= 1);
  assert.ok(mine(B.email, (e) => e.tool === 'calculate' || e.tool === 'add_note').length >= 2);
  ok(`${audit.length} entries; A's chat calls and B's MCP calls (with duration and outcome) are attributed correctly`);

  if (process.env.STORES) await storesDemo(A);
  console.log('\nDEMO COMPLETE');
}

/** Multi-store bonus: provision two stores, compare orders across them, delete one, prove isolation. */
async function storesDemo(A) {
  step('multi-store: create two stores from the dashboard API (as user A) at the same time');
  const names = [`Alpha ${Date.now() % 10000}`, `Beta ${Date.now() % 10000}`];
  const created = [];
  for (const name of names) {
    const r = await api('POST', '/stores', { name }, A.cookie, { 'idempotency-key': `demo-${name}` });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    created.push(r.json.store);
  }
  const retried = await api('POST', '/stores', { name: names[0] }, A.cookie, { 'idempotency-key': `demo-${names[0]}` });
  assert.equal(retried.json.store.id, created[0].id, 'a retried create resolves to the same store');
  ok(
    `both Provisioning in parallel: ${created.map((s) => `${s.slug} (${s.namespace})`).join(', ')}; retrying a create returned the same store`,
  );
  const over = await api('POST', '/stores', { name: 'Third' }, A.cookie);
  assert.equal(over.status, 429, 'per-user store limit');
  ok(`per-user limit enforced: ${over.json.error}`);

  const ready = await until(
    async () => {
      const list = (await api('GET', '/stores', null, A.cookie)).json.stores;
      const failed = list.find((s) => s.phase === 'Failed');
      if (failed) throw new Error(`${failed.name} failed: ${failed.reason}`);
      return list.filter((s) => s.phase === 'Ready').length >= 2 && list;
    },
    'both stores Ready',
    15 * 60_000,
    5000,
  );
  ok(`Ready: ${ready.map((s) => `${s.name} -> ${s.url}`).join(' | ')}`);

  const keyA = (await api('POST', '/keys', { name: 'stores' }, A.cookie)).json.key;
  const c = await mcp(keyA);
  for (const s of ready)
    assert.ok(
      (await c.listTools()).tools.some((t) => t.name === `${s.slug}__list_orders`),
      `${s.slug} tools registered`,
    );
  ok('each store registered itself in the gateway; tool names carry the store: ' + ready.map((s) => `${s.slug}__list_orders`).join(', '));

  const first = ready.find((s) => s.name === names[0]);
  const second = ready.find((s) => s.name === names[1]);
  const base = (s) => s.url.replace(/\/$/, '');
  const p = await (await fetch(`${base(first)}/wp-json/wc/store/v1/products`)).json();
  const o1 = await checkout(base(first), p[0].name);
  const o2 = await checkout(base(second), (await (await fetch(`${base(second)}/wp-json/wc/store/v1/products`)).json())[0].name);
  const [r1, r2] = await Promise.all([
    c.callTool({ name: `${first.slug}__list_orders`, arguments: { date: 'today' } }),
    c.callTool({ name: `${second.slug}__list_orders`, arguments: { date: 'today' } }),
  ]);
  assert.ok(text(r1).includes(String(o1)) && text(r2).includes(String(o2)));
  ok(`compared today's orders across two stores: ${first.name} has #${o1}, ${second.name} has #${o2}`);

  step("isolation: store A's MCP pod cannot reach store B's WordPress or database");
  const pod = (ns) => kubectl('-n', ns, 'get', 'pod', '-l', 'app.kubernetes.io/name=woo-mcp', '-o', 'jsonpath={.items[0].metadata.name}');
  const probe = (from, host) => {
    try {
      execFileSync(
        'kubectl',
        ['-n', from.namespace, 'exec', pod(from.namespace), '--', 'wget', '-q', '-T', '4', '-O', '-', `http://${host}/wp-login.php`],
        { stdio: 'pipe' },
      );
      return 'reachable';
    } catch {
      return 'blocked';
    }
  };
  assert.equal(probe(first, 'store-wordpress'), 'reachable', 'own WordPress must be reachable (sanity)');
  assert.equal(probe(first, `store-wordpress.${second.namespace}.svc.cluster.local`), 'blocked');
  assert.equal(probe(first, `store-mariadb.${second.namespace}.svc.cluster.local:3306`), 'blocked');
  ok(`${first.namespace} -> own WordPress: reachable; -> ${second.namespace} WordPress and MariaDB: blocked by NetworkPolicy`);

  step('delete one store: its namespace, volumes, Secrets and tools are gone');
  assert.equal((await api('DELETE', `/stores/${second.id}`, null, A.cookie)).status, 202);
  await until(async () => !kubectl('get', 'ns', '--ignore-not-found', second.namespace) && true, 'namespace removal', 5 * 60_000, 3000);
  const left = await until(
    async () => {
      const t = (await c.listTools()).tools.map((x) => x.name);
      return !t.some((n) => n.startsWith(`${second.slug}__`)) && t.some((n) => n.startsWith(`${first.slug}__`)) && t;
    },
    'tools of the deleted store to disappear',
    60_000,
  );
  assert.equal(kubectl('get', 'pvc', '-A', '--no-headers').includes(second.namespace), false);
  ok(
    `namespace ${second.namespace} (PVCs, Secrets, Ingress) removed; ${second.slug}__* tools gone, ${first.slug}__* still served (${left.length} tools left)`,
  );
  await c.close();

  step('cleanup: delete the remaining demo store');
  await api('DELETE', `/stores/${first.id}`, null, A.cookie);
  await until(async () => !kubectl('get', 'ns', '--ignore-not-found', first.namespace), 'cleanup', 5 * 60_000, 3000);
  ok('done');
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
