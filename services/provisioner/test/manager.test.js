import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, ApiError, PHASE } from '../src/manager.js';

const P = 'woo-platform/';

/** In-memory stand-in for the Kubernetes API: namespaces + secrets. */
function fakeK8s() {
  const namespaces = new Map();
  return {
    namespaces,
    getNamespace: async (n) => namespaces.get(n) ?? null,
    listNamespaces: async (selector) => {
      const [k, v] = selector.split('=');
      return [...namespaces.values()].filter((ns) => ns.metadata.labels?.[k] === v);
    },
    createNamespace: async (obj) => {
      if (namespaces.has(obj.metadata.name)) throw Object.assign(new Error('exists'), { status: 409 });
      namespaces.set(obj.metadata.name, structuredClone(obj));
    },
    patchNamespace: async (n, { annotations }) => {
      const ns = namespaces.get(n);
      for (const [k, v] of Object.entries(annotations || {}))
        v === null ? delete ns.metadata.annotations[k] : (ns.metadata.annotations[k] = v);
    },
    deleteNamespace: async (n) => namespaces.delete(n),
    getSecret: async () => ({
      data: { 'woo-mcp-token': Buffer.from('tok').toString('base64'), token: Buffer.from('tok').toString('base64') },
    }),
  };
}

function setup(over = {}) {
  const k8s = fakeK8s();
  const registered = new Map();
  const helmCalls = [];
  let clock = 1_000_000;
  const gateway = {
    register: async (ref, s) => registered.set(ref, s),
    deregister: async (ref) => registered.delete(ref),
    list: async () => [...registered.keys()].map((ref) => ({ ref, slug: registered.get(ref).slug, source: 'store' })),
  };
  const cfg = {
    maxStoresPerUser: 2,
    maxStoresTotal: 3,
    provisionTimeoutSec: 600,
    storeDomainSuffix: 'stores.test',
    storeScheme: 'http',
    storePort: ':8080',
    storeValues: { store: { image: 'x' } },
    hostedValues: {},
    hostedAllowedRegistries: ['woo-platform/'],
    hostedMaxServers: 2,
    workDir: process.env.TEMP || '/tmp',
    chartPath: '/charts/platform',
    hostedChartPath: '/charts/hosted-mcp',
    ...over,
  };
  const runHelm = async (args) => {
    helmCalls.push(args);
    return '';
  };
  const log = { log() {}, warn() {}, error() {} };
  const manager = createManager({ cfg, k8s, runHelm, gateway, log, now: () => clock });
  return { manager, k8s, registered, helmCalls, tick: (ms) => (clock += ms), cfg };
}

const alice = { id: 'u-alice', email: 'alice@example.com', role: 'member' };
const bob = { id: 'u-bob', email: 'bob@example.com', role: 'member' };
const admin = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };
const settle = async (m) => {
  while ([...m.jobs.values()].length) await new Promise((r) => setTimeout(r, 5));
};

test('creating a store provisions it, registers it with the gateway and marks it Ready', async () => {
  const { manager, registered, helmCalls } = setup();
  const s = await manager.createStore(alice, { name: 'Acme Coffee' });
  assert.equal(s.phase, PHASE.PROVISIONING);
  assert.equal(s.slug, 'store-acme-coffee');
  await settle(manager);
  const [ready] = await manager.list('store', alice);
  assert.equal(ready.phase, PHASE.READY);
  assert.equal(ready.url, 'http://store-acme-coffee.stores.test:8080');
  assert.equal(helmCalls[0][0], 'upgrade');
  assert.deepEqual(registered.get(s.id), {
    slug: 'store-acme-coffee',
    name: 'Store: Acme Coffee',
    url: `http://store-woo-mcp.store-${s.id}.svc.cluster.local:3000/mcp`,
    credential: { token: 'tok' },
    source: 'store',
  });
});

test('create is idempotent: the same Idempotency-Key resolves to the same store', async () => {
  const { manager, helmCalls } = setup();
  const a = await manager.createStore(alice, { name: 'Shop' }, 'req-1');
  const b = await manager.createStore(alice, { name: 'Shop' }, 'req-1');
  await settle(manager);
  assert.equal(a.id, b.id);
  assert.equal((await manager.list('store', admin)).length, 1);
  assert.equal(helmCalls.length, 1, 'helm ran once');
});

test('per-user and total limits are enforced', async () => {
  const { manager } = setup();
  await manager.createStore(alice, { name: 'One' });
  await manager.createStore(alice, { name: 'Two' });
  await assert.rejects(
    manager.createStore(alice, { name: 'Three' }),
    (e) => e instanceof ApiError && e.status === 429 && /limit 2 per user/.test(e.message),
  );
  await manager.createStore(bob, { name: 'Bobs' });
  await assert.rejects(manager.createStore(bob, { name: 'Bobs two' }), (e) => e.status === 429 && /limited to 3 stores/.test(e.message));
  await settle(manager);
});

test('members only see their own stores; admins see all; strangers cannot delete', async () => {
  const { manager } = setup();
  const s = await manager.createStore(alice, { name: 'Alice shop' });
  await settle(manager);
  assert.equal((await manager.list('store', bob)).length, 0);
  assert.equal((await manager.list('store', admin)).length, 1);
  await assert.rejects(manager.remove('store', bob, s.id), (e) => e.status === 404);
  await manager.remove('store', alice, s.id);
});

test('deleting removes the registration and the namespace', async () => {
  const { manager, registered, k8s } = setup();
  const s = await manager.createStore(alice, { name: 'Temp' });
  await settle(manager);
  assert.ok(registered.has(s.id));
  await manager.remove('store', alice, s.id);
  await settle(manager);
  assert.ok(!registered.has(s.id));
  assert.ok(!k8s.namespaces.has(`store-${s.id}`));
});

test('a helm failure marks the store Failed with the reason, and retry completes it', async () => {
  let fail = true;
  const ctx = setup();
  const manager = createManager({
    cfg: ctx.cfg,
    k8s: ctx.k8s,
    gateway: { register: async () => {}, deregister: async () => {}, list: async () => [] },
    runHelm: async () => {
      if (fail) throw new Error('helm upgrade failed: image pull error');
    },
    log: { log() {}, warn() {}, error() {} },
    now: () => 1_000_000,
  });
  const s = await manager.createStore(alice, { name: 'Flaky' });
  await settle(manager);
  let [cur] = await manager.list('store', alice);
  assert.equal(cur.phase, PHASE.FAILED);
  assert.match(cur.reason, /image pull error/);
  fail = false;
  await manager.retry('store', alice, s.id);
  await settle(manager);
  [cur] = await manager.list('store', alice);
  assert.equal(cur.phase, PHASE.READY);
});

test('reconcile fails an overdue Provisioning store and resumes an unfinished one after a restart', async () => {
  const ctx = setup();
  // Simulate a previous provisioner instance that died mid-provisioning: namespace exists, no job is running.
  const mkNs = (id, deadline) => ({
    metadata: {
      name: `store-${id}`,
      labels: { [`${P}kind`]: 'store', [`${P}owner`]: alice.id },
      annotations: {
        [`${P}name`]: id,
        [`${P}slug`]: `store-${id}`,
        [`${P}owner-email`]: alice.email,
        [`${P}phase`]: PHASE.PROVISIONING,
        [`${P}created`]: '1000000',
        [`${P}deadline`]: String(deadline),
      },
    },
  });
  ctx.k8s.namespaces.set('store-late', mkNs('late', 1_000_000 - 1));
  ctx.k8s.namespaces.set('store-fresh', mkNs('fresh', 1_000_000 + 60_000));
  await ctx.manager.reconcile();
  await settle(ctx.manager);
  const byId = Object.fromEntries((await ctx.manager.list('store', admin)).map((s) => [s.id, s]));
  assert.equal(byId['late'].phase, PHASE.FAILED);
  assert.match(byId['late'].reason, /timed out/);
  assert.equal(byId['fresh'].phase, PHASE.READY, 'resumed and completed');
});

test('reconcile removes gateway registrations of stores that no longer exist', async () => {
  const ctx = setup();
  ctx.registered.set('ghost', { slug: 'store-ghost' });
  await ctx.manager.reconcile();
  assert.ok(!ctx.registered.has('ghost'));
});

test('hosted servers: only allowed registries, valid env names, and a cap', async () => {
  const { manager } = setup();
  await assert.rejects(
    manager.createHosted(admin, { name: 'Bad', image: 'evil.io/x:1' }),
    (e) => e.status === 400 && /allowed registry/.test(e.message),
  );
  await assert.rejects(
    manager.createHosted(admin, { name: 'Bad', image: 'woo-platform/x:1', env: { 'bad name': '1' } }),
    (e) => e.status === 400,
  );
  const h = await manager.createHosted(admin, { name: 'Utils', image: 'woo-platform/demo-mcp:dev', env: { KIND: 'utils' } });
  assert.equal(h.slug, 'utils');
  await assert.rejects(manager.createHosted(admin, { name: 'Utils', image: 'woo-platform/demo-mcp:dev' }), (e) => e.status === 409);
  await settle(manager);
});
