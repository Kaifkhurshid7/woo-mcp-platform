# WooCommerce hosting platform with a team MCP gateway

A WooCommerce store on Kubernetes, an MCP server for it that I wrote from scratch, and a **gateway** that
lets an admin register MCP servers once and every team member use all of them through **one MCP endpoint**
and a **chat agent** in a React dashboard. One Helm chart runs it on a local cluster and on a k3s VPS; only
values differ.

```
store (WordPress+WooCommerce+MariaDB) ◀─REST─ woo-mcp ─┐
                                    notes-mcp ──────────┼─◀ gateway (MCP client to all, MCP server for all) ◀─ Claude Code / Cursor / Inspector
                                    utils-mcp ──────────┘        ▲  users · API keys · audit · SSRF guard · timeouts
                                                                 └─ dashboard (React) + chat agent (LLM tool loop)
```

| Layer | Where | Notes |
|---|---|---|
| Store | `images/wordpress` | official WordPress image + WooCommerce + Storefront baked in; idempotent bootstrap (install, COD, shipping, sample product, REST key from a Secret) |
| WooCommerce MCP server | `images/woo-mcp` | written from scratch; Streamable HTTP; tools `list_products`, `get_product`, `create_product`, `list_orders`, `get_order`, `update_order_status`; uses the WooCommerce REST API ([why](docs/ARCHITECTURE.md#woocommerce-mcp-server-how-it-talks-to-the-store-and-why)) |
| Extra upstreams | `images/demo-mcp` | `notes` (shared scratch-pad) and `utils` (calculator, clock): the 2nd and 3rd upstream; both expose `ping` on purpose to show collision handling |
| Gateway | `images/gateway` | Node 22, SQLite; REST API + MCP endpoint + chat agent |
| Dashboard | `images/dashboard` | React + Vite, served by unprivileged nginx |
| Deployment | `charts/platform` | Helm only; `values-local.yaml`, `values-prod.yaml` |

## Quick start (local, ~10 min)

Requirements: Docker, [k3d](https://k3d.io), kubectl, Helm 3, make.

```bash
export LLM_API_KEY=...        # optional now; needed only for the chat agent (see docs/DEMO.md for other providers)
make up                       # cluster + images + helm install + prints logins
```

* Storefront: http://store.localtest.me:8080 · WooCommerce admin: `/wp-admin`
* Dashboard: http://dash.localtest.me:8080 · MCP endpoint: http://dash.localtest.me:8080/mcp
* `make creds` prints the generated passwords (they live in a Kubernetes Secret, not in this repo).

**Local domain approach:** `*.localtest.me` is public wildcard DNS for `127.0.0.1`, and k3d maps host port 8080
to the cluster's Traefik ingress, so stable URLs work with no `/etc/hosts` edits. On kind, set
`ingress.className=nginx` and `networkPolicy.ingressControllerNamespace=ingress-nginx`.

The step-by-step demo of the full flow (two users, chat, external client, revoke, disable, kill a pod, audit) is in
[docs/DEMO.md](docs/DEMO.md). Deploying to a VPS, TLS and upgrade/rollback: [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md).
Design decisions, naming scheme, security model, limitations: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements checklist

| Requirement | How it is met |
|---|---|
| Local K8s + same chart on a VPS | k3d locally, k3s on the VPS; `values-local.yaml` vs `values-prod.yaml` |
| Helm only | `charts/platform`, no Kustomize |
| Everything in-cluster, persistent store | MariaDB StatefulSet PVC, WordPress content PVC, gateway PVC |
| Ingress with stable URLs | two Ingress objects (store, dashboard+gateway) on fixed hosts |
| Probes + requests/limits on every workload | all 7 workloads (checked by `tests/chart_check.py`) |
| No hardcoded secrets | one K8s Secret (generated or `existingSecret`), consumed via `secretKeyRef`; LLM key via `--set` or the Secret |
| Own WooCommerce MCP server, Streamable HTTP, ≥5 tools, internal only | `images/woo-mcp`; ClusterIP, no Ingress, NetworkPolicy admits only the gateway, bearer token |
| Gateway: add/edit/disable/remove upstreams with optional credential | dashboard **Servers** page; credentials AES-GCM encrypted, never returned |
| One MCP endpoint, routing, collisions, isolation, timeouts | `POST /mcp`; `<slug>__<tool>`; cached listing + per-call deadline |
| ≥3 upstreams | woo, notes, utils (and any you add) |
| Roles, per-user hashed revocable keys, audit log in UI | admin/member; SHA-256-hashed `gw_…` keys; **Audit log** page |
| Chat agent as the logged-in user, shows tool calls | `POST /api/chat`, audit `source=chat`, tool trace in the UI |
| Differentiators implemented | tool permissions (admin-only patterns), SSRF guard, encrypted credentials at rest, default-deny NetworkPolicies + non-root, read-only containers for the Node/nginx workloads, Prometheus `/metrics` and failure reasons in the UI, per-user rate limit (per replica), VPS values + cert-manager TLS config and upgrade/rollback docs (prepared, not deployed by me) |
| Not done | multi-store provisioning bonus, OAuth on the gateway, hosted (image-based) MCP servers, many-tools search/execute, multi-replica gateway |

## Repository layout

```
charts/platform/     Helm chart (values.yaml, values-local.yaml, values-prod.yaml, templates/)
images/              wordpress, woo-mcp, demo-mcp, gateway, dashboard (each with its Dockerfile)
scripts/             k3d-up, build-images, deploy-local, creds, create-secret, push-images, dev
tests/               e2e.mjs (platform logic), smoke.mjs (live deployment), ui-smoke.mjs (dashboard in jsdom), chart_check.py + chartcheck/ (offline chart check)
docs/                ARCHITECTURE, DEMO, DEPLOY-VPS
```

## Development without Kubernetes

`make dev` starts a fake WooCommerce, the three MCP servers, the gateway and the Vite dashboard on your machine
(chat answers come from a scripted mock model unless you set an LLM key). `make test` runs the unit tests,
`make e2e` the end-to-end test.

## What was verified (and what was not)

Verified in the build environment (no Docker daemon, no Kubernetes, no Helm binary):

* **Unit tests** (Node): date windows, calculator, SSRF guard, crypto/vault, tool naming. `make test`
* **End-to-end test, 17 checks** (`make e2e`): real woo-mcp, notes, utils and gateway processes against a fake WooCommerce REST API that enforces
  key auth: seeded servers connected, two users via invites, chat agent creates a product and lists today's order, external MCP client
  (official SDK) with user B's key sees every tool and runs a three-server workflow, key revocation → 401, hanging upstream times out cleanly while other servers
  answer and listing stays fast, disabling a server hides its tools from both chat and MCP client, killing an upstream marks it Unreachable while the others keep
  working, audit log attribution (chat vs MCP, per user), SSRF rejection, no secret stored in plaintext, metrics.
* **Dashboard**: builds with Vite, and `tests/ui-smoke.mjs` renders the built app in jsdom against a live gateway and clicks through login, servers, tool list, key creation, chat (with tool trace), audit and team. Not opened in a real browser, so visual layout/CSS is unchecked.
* **Helm chart**: rendered with an offline re-implementation of the template functions and checked structurally
  (`make chart-check`): probes, requests/limits, hardening, Secret wiring, ingress hosts/backends, NetworkPolicies, PVCs, local/prod/existing-Secret/TLS variants.

**Not verified here:** building the Docker images, the real WordPress/WooCommerce bootstrap (written against WP-CLI and WooCommerce APIs but never run), Helm itself
(`make lint-chart` is the real check: run it first), and behavior on an actual cluster (NetworkPolicy enforcement, ingress, k3s). Expect to fix small issues on the
first `make up`; the most likely places are the WordPress bootstrap script (`images/wordpress/bootstrap.sh`) and WooCommerce version-specific options.
# woo-mcp-platform
