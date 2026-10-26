/**
 * Lifecycle manager for tenant stores and hosted MCP servers.
 *
 * Each store / hosted server lives in its own namespace. The namespace's labels and annotations ARE the
 * record of its state (phase, reason, deadline, owner, ...), so no database is needed and a restarted
 * provisioner recovers by listing namespaces:
 *
 *   Provisioning --helm ok + registered--> Ready
 *        |  \--error or deadline passed--> Failed (with a reason)
 *   any --delete requested--> Deleting --namespace gone--> (removed)
 *
 * Every step is idempotent (helm upgrade --install, namespace create-or-adopt, PUT registration), so
 * retrying a create or resuming after a restart can never produce duplicates.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const P = 'woo-platform/';
export const PHASE = { PROVISIONING: 'Provisioning', READY: 'Ready', FAILED: 'Failed', DELETING: 'Deleting' };

/** Error carrying the HTTP status the API should answer with. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] || {}, v) : v;
  return out;
};

const KINDS = {
  store: { nsPrefix: 'store', release: 'store', label: 'store' },
  hosted: { nsPrefix: 'mcpx', release: 'mcp', label: 'hosted' },
};

/**
 * @param {{cfg: object, k8s: object, runHelm: Function, gateway: object, log?: Console, now?: () => number}} deps
 */
export function createManager({ cfg, k8s, runHelm, gateway, log = console, now = Date.now }) {
  const jobs = new Map(); // job key -> AbortController

  const ann = (ns) => ns.metadata.annotations || {};
  const a = (ns, key) => ann(ns)[P + key];
  const idOf = (ns) => ns.metadata.name.replace(/^[a-z]+-/, '');
  const kindOf = (ns) => ns.metadata.labels?.[`${P}kind`];

  /** Public view of a namespace-as-record. */
  function view(ns) {
    const kind = kindOf(ns);
    const spec = a(ns, 'spec') ? JSON.parse(a(ns, 'spec')) : {};
    return {
      id: idOf(ns),
      kind,
      name: a(ns, 'name'),
      slug: a(ns, 'slug'),
      phase: a(ns, 'phase'),
      reason: a(ns, 'reason') || null,
      url: a(ns, 'url') || null,
      owner: a(ns, 'owner-email'),
      ownerId: ns.metadata.labels?.[`${P}owner`],
      namespace: ns.metadata.name,
      createdAt: Number(a(ns, 'created')),
      deadline: Number(a(ns, 'deadline')) || null,
      ...(kind === 'hosted' ? { image: spec.image } : {}),
    };
  }

  const setState = (nsName, annotations) =>
    k8s.patchNamespace(nsName, { annotations: Object.fromEntries(Object.entries(annotations).map(([k, v]) => [P + k, v])) });

  async function listAll(kind) {
    return (await k8s.listNamespaces(`${P}kind=${kind}`)).filter((ns) => !ns.metadata.deletionTimestamp || a(ns, 'phase'));
  }

  // ---------------------------------------------------------------- creation

  /** Deterministic id for an idempotency key, so a retried request resolves to the same store. */
  const makeId = (userId, idemKey) =>
    idemKey ? crypto.createHash('sha256').update(`${userId}:${idemKey}`).digest('hex').slice(0, 8) : crypto.randomBytes(4).toString('hex');

  async function createNamespaceRecord({ kind, user, id, name, slug, spec, timeoutSec }) {
    const k = KINDS[kind];
    const nsName = `${k.nsPrefix}-${id}`;
    const existing = await k8s.getNamespace(nsName);
    if (existing) return view(existing); // retried request: adopt, never duplicate
    const t = now();
    try {
      await k8s.createNamespace({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: nsName,
          labels: { [`${P}kind`]: kind, [`${P}owner`]: user.id, 'app.kubernetes.io/managed-by': 'woo-platform-provisioner' },
          annotations: {
            [`${P}name`]: name,
            [`${P}slug`]: slug,
            [`${P}owner-email`]: user.email,
            [`${P}phase`]: PHASE.PROVISIONING,
            [`${P}created`]: String(t),
            [`${P}deadline`]: String(t + timeoutSec * 1000),
            ...(spec ? { [`${P}spec`]: JSON.stringify(spec) } : {}),
          },
        },
      });
    } catch (e) {
      if (e.status !== 409) throw e; // a concurrent identical request created it first
    }
    startProvision(nsName);
    return view(await k8s.getNamespace(nsName));
  }

  /**
   * Create a store for `user`. Enforces the per-user and total limits.
   * @param {{id: string, email: string, role: string}} user
   */
  async function createStore(user, { name }, idemKey) {
    const clean = String(name || '').trim();
    if (clean.length < 2 || clean.length > 40) throw new ApiError(400, 'Store name must be 2-40 characters');
    const id = makeId(user.id, idemKey);
    const existing = await k8s.getNamespace(`store-${id}`);
    if (existing) return view(existing);

    const all = (await listAll('store')).filter((ns) => a(ns, 'phase') !== PHASE.DELETING);
    if (all.length >= cfg.maxStoresTotal)
      throw new ApiError(429, `The platform is limited to ${cfg.maxStoresTotal} stores. Delete one first.`);
    const mine = all.filter((ns) => ns.metadata.labels?.[`${P}owner`] === user.id).length;
    if (mine >= cfg.maxStoresPerUser)
      throw new ApiError(429, `You already have ${mine} stores (limit ${cfg.maxStoresPerUser} per user). Delete one first.`);

    let slug = `store-${slugify(clean)}`.slice(0, 24).replace(/-+$/, '');
    if (all.some((ns) => a(ns, 'slug') === slug)) slug = `${slug.slice(0, 19)}-${id.slice(0, 4)}`.replace(/-+/g, '-');
    return createNamespaceRecord({ kind: 'store', user, id, name: clean, slug, timeoutSec: cfg.provisionTimeoutSec });
  }

  /** Create a hosted MCP server from a container image (admin only; checked by the caller). */
  async function createHosted(user, body, idemKey) {
    const name = String(body?.name || '').trim();
    const image = String(body?.image || '').trim();
    if (name.length < 2 || name.length > 40) throw new ApiError(400, 'Name must be 2-40 characters');
    if (!/^[a-z0-9][a-z0-9._\-/:@]{1,200}$/.test(image)) throw new ApiError(400, 'Image reference is not valid');
    if (!cfg.hostedAllowedRegistries.some((r) => image.startsWith(r)))
      throw new ApiError(400, `Image must come from an allowed registry: ${cfg.hostedAllowedRegistries.join(', ')}`);
    const port = Number(body?.port ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'Port is not valid');
    const mcpPath = String(body?.path || '/mcp');
    if (!/^\/[A-Za-z0-9._\-/]*$/.test(mcpPath)) throw new ApiError(400, 'Path is not valid');
    const tokenEnv = body?.tokenEnv === undefined ? 'MCP_AUTH_TOKEN' : String(body.tokenEnv);
    if (tokenEnv && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(tokenEnv)) throw new ApiError(400, 'tokenEnv must be an environment variable name');
    const env =
      body?.env && typeof body.env === 'object'
        ? Object.fromEntries(
            Object.entries(body.env)
              .slice(0, 20)
              .map(([k, v]) => [String(k), String(v)]),
          )
        : {};
    for (const k of Object.keys(env))
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) throw new ApiError(400, `Invalid environment variable name: ${k}`);

    const id = makeId(user.id, idemKey);
    const existing = await k8s.getNamespace(`mcpx-${id}`);
    if (existing) return view(existing);
    const all = (await listAll('hosted')).filter((ns) => a(ns, 'phase') !== PHASE.DELETING);
    if (all.length >= cfg.hostedMaxServers) throw new ApiError(429, `Limited to ${cfg.hostedMaxServers} hosted servers`);
    const slug = slugify(name).slice(0, 24).replace(/-+$/, '') || `mcp-${id.slice(0, 4)}`;
    if (all.some((ns) => a(ns, 'slug') === slug)) throw new ApiError(409, `A hosted server named "${slug}" already exists`);
    return createNamespaceRecord({
      kind: 'hosted',
      user,
      id,
      name,
      slug,
      spec: { image, port, path: mcpPath, tokenEnv, env },
      timeoutSec: 300,
    });
  }

  // ---------------------------------------------------------------- provisioning job

  /** Helm values for one namespace, derived only from its record (so a resumed job rebuilds the same thing). */
  function valuesFor(ns) {
    const kind = kindOf(ns);
    if (kind === 'store') {
      const host = `${a(ns, 'slug')}.${cfg.storeDomainSuffix}`;
      return deepMerge(cfg.storeValues, {
        mode: 'store',
        domain: { store: host, scheme: cfg.storeScheme, port: cfg.storePort },
        store: { title: a(ns, 'name') },
        secrets: { adminEmail: a(ns, 'owner-email') },
      });
    }
    const spec = JSON.parse(a(ns, 'spec'));
    return deepMerge(cfg.hostedValues, { name: 'mcp-server', image: spec.image, port: spec.port, tokenEnv: spec.tokenEnv, env: spec.env });
  }

  /** Where the gateway should reach this namespace's MCP server, and the credential it needs. */
  async function registrationFor(ns) {
    const kind = kindOf(ns);
    const nsName = ns.metadata.name;
    if (kind === 'store') {
      const secret = await k8s.getSecret(nsName, 'store-secrets');
      const token = secret?.data?.['woo-mcp-token'] ? Buffer.from(secret.data['woo-mcp-token'], 'base64').toString() : null;
      if (!token) throw new Error('the store secret has no woo-mcp token yet');
      return {
        slug: a(ns, 'slug'),
        name: `Store: ${a(ns, 'name')}`,
        url: `http://store-woo-mcp.${nsName}.svc.cluster.local:3000/mcp`,
        credential: { token },
        source: 'store',
      };
    }
    const spec = JSON.parse(a(ns, 'spec'));
    let token = null;
    if (spec.tokenEnv) {
      const secret = await k8s.getSecret(nsName, 'mcp-secrets');
      token = secret?.data?.token ? Buffer.from(secret.data.token, 'base64').toString() : null;
    }
    return {
      slug: a(ns, 'slug'),
      name: `Hosted: ${a(ns, 'name')}`,
      url: `http://mcp-server.${nsName}.svc.cluster.local:${spec.port}${spec.path}`,
      credential: token ? { token } : null,
      source: 'hosted',
    };
  }

  async function doProvision(nsName, signal) {
    const ns = await k8s.getNamespace(nsName);
    if (!ns || a(ns, 'phase') !== PHASE.PROVISIONING) return;
    const kind = kindOf(ns);
    const remainingMs = Number(a(ns, 'deadline')) - now();
    if (remainingMs <= 0) throw new Error(`provisioning timed out after ${cfg.provisionTimeoutSec}s`);

    await fs.mkdir(cfg.workDir, { recursive: true });
    const file = path.join(cfg.workDir, `${nsName}.json`);
    await fs.writeFile(file, JSON.stringify(valuesFor(ns)), { mode: 0o600 });
    const chart = kind === 'store' ? cfg.chartPath : cfg.hostedChartPath;
    try {
      await runHelm(
        [
          'upgrade',
          '--install',
          KINDS[kind].release,
          chart,
          '--namespace',
          nsName,
          '-f',
          file,
          '--wait',
          '--timeout',
          `${Math.ceil(remainingMs / 1000)}s`,
        ],
        { signal, timeoutMs: remainingMs + 30_000 },
      );
    } finally {
      await fs.rm(file, { force: true });
    }

    const reg = await registrationFor(ns);
    await gateway.register(idOf(ns), reg);
    const url = kind === 'store' ? `${cfg.storeScheme}://${a(ns, 'slug')}.${cfg.storeDomainSuffix}${cfg.storePort}` : '';
    await setState(nsName, { phase: PHASE.READY, reason: null, url });
    log.log(`[${kind}] ${nsName} is Ready`);
  }

  function startProvision(nsName) {
    if (jobs.has(nsName)) return;
    const ac = new AbortController();
    jobs.set(nsName, ac);
    doProvision(nsName, ac.signal)
      .catch(async (e) => {
        if (ac.signal.aborted) return; // the reconciler already recorded why
        log.error(`[provision] ${nsName} failed: ${e.message}`);
        await setState(nsName, { phase: PHASE.FAILED, reason: String(e.message).slice(0, 300) }).catch(() => {});
      })
      .finally(() => jobs.delete(nsName));
  }

  // ---------------------------------------------------------------- deletion

  function startDelete(nsName) {
    const key = `del:${nsName}`;
    if (jobs.has(key)) return;
    jobs.set(key, new AbortController());
    (async () => {
      const ns = await k8s.getNamespace(nsName);
      if (!ns) return;
      const kind = kindOf(ns);
      await gateway.deregister(idOf(ns)).catch((e) => log.warn(`[delete] could not deregister ${nsName} yet: ${e.message}`));
      await runHelm(['uninstall', KINDS[kind].release, '--namespace', nsName, '--wait', '--timeout', '120s']).catch(() => {}); // already gone is fine
      await k8s.deleteNamespace(nsName); // removes PVCs, Secrets, Ingress, everything inside
      log.log(`[${kind}] ${nsName} deleted`);
    })()
      .catch((e) => log.error(`[delete] ${nsName}: ${e.message}`))
      .finally(() => jobs.delete(key));
  }

  /** Delete a store/hosted server. Allowed for its owner and for admins. */
  async function remove(kind, user, id) {
    const nsName = `${KINDS[kind].nsPrefix}-${id}`;
    const ns = await k8s.getNamespace(nsName);
    if (!ns || kindOf(ns) !== kind) throw new ApiError(404, 'Not found');
    if (user.role !== 'admin' && ns.metadata.labels?.[`${P}owner`] !== user.id) throw new ApiError(404, 'Not found');
    jobs.get(nsName)?.abort('deleted');
    await setState(nsName, { phase: PHASE.DELETING, reason: null });
    startDelete(nsName);
    return view(await k8s.getNamespace(nsName));
  }

  /** Re-run a Failed (or stuck) provisioning with a fresh deadline. Safe because every step is idempotent. */
  async function retry(kind, user, id) {
    const nsName = `${KINDS[kind].nsPrefix}-${id}`;
    const ns = await k8s.getNamespace(nsName);
    if (!ns || kindOf(ns) !== kind || (user.role !== 'admin' && ns.metadata.labels?.[`${P}owner`] !== user.id))
      throw new ApiError(404, 'Not found');
    if (a(ns, 'phase') !== PHASE.FAILED) throw new ApiError(409, `Only Failed items can be retried (this one is ${a(ns, 'phase')})`);
    await setState(nsName, { phase: PHASE.PROVISIONING, reason: null, deadline: String(now() + cfg.provisionTimeoutSec * 1000) });
    startProvision(nsName);
    return view(await k8s.getNamespace(nsName));
  }

  async function list(kind, user) {
    const items = (await listAll(kind)).map(view);
    return user.role === 'admin' ? items : items.filter((i) => i.ownerId === user.id);
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * One reconciliation pass; runs on start-up and then periodically. This is what makes a provisioner
   * restart safe: unfinished work is resumed, overdue work is failed with a reason, deletions are finished,
   * and the gateway registrations are brought back in line with the cluster.
   */
  async function reconcile() {
    const namespaces = [...(await listAll('store')), ...(await listAll('hosted'))];
    for (const ns of namespaces) {
      const nsName = ns.metadata.name;
      const phase = a(ns, 'phase');
      if (phase === PHASE.PROVISIONING) {
        if (now() > Number(a(ns, 'deadline'))) {
          jobs.get(nsName)?.abort('timeout');
          await setState(nsName, {
            phase: PHASE.FAILED,
            reason: `Provisioning timed out after ${cfg.provisionTimeoutSec}s. Check the pods in namespace ${nsName}, then retry or delete.`,
          });
          log.warn(`[reconcile] ${nsName} timed out`);
        } else if (!jobs.has(nsName)) {
          log.log(`[reconcile] resuming ${nsName}`);
          startProvision(nsName);
        }
      } else if (phase === PHASE.DELETING) {
        startDelete(nsName);
      }
    }

    try {
      const registered = new Map((await gateway.list()).map((r) => [r.ref, r]));
      const live = new Set(namespaces.filter((ns) => a(ns, 'phase') !== PHASE.DELETING).map(idOf));
      for (const ns of namespaces.filter((n) => a(n, 'phase') === PHASE.READY)) {
        if (!registered.has(idOf(ns))) await gateway.register(idOf(ns), await registrationFor(ns)); // gateway DB was reset
      }
      for (const ref of registered.keys()) if (!live.has(ref)) await gateway.deregister(ref); // store no longer exists
    } catch (e) {
      log.warn(`[reconcile] gateway sync skipped: ${e.message}`);
    }
  }

  return { createStore, createHosted, remove, retry, list, reconcile, view, jobs };
}
