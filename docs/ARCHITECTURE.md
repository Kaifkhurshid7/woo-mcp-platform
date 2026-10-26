# Architecture and design decisions

```
                        browser / MCP clients (Claude Code, Cursor, Inspector)
                                   │                         │
                   storefront ─────┤                         │
              store.<domain>       │   dash.<domain>         │
                                   ▼                         ▼
                          ┌──────── Ingress (Traefik / nginx) ────────┐
                          │ store.*  →  wordpress                      │
                          │ dash.*   →  /api, /mcp → gateway           │
                          │             /          → dashboard (nginx) │
                          └──────────────┬─────────────────────────────┘
                                         │
   ┌──────────────┐   ┌──────────────────▼───────────────────┐
   │  dashboard   │──▶│ gateway (Node)                        │
   │ React SPA    │   │  • REST API for the dashboard         │
   └──────────────┘   │  • MCP server  POST /mcp (stateless)  │
                      │  • MCP client to every upstream       │
                      │  • users, API keys, audit, chat agent │──▶ LLM API (key from Secret)
                      │  • SQLite on a PVC                    │
                      └───┬───────────┬──────────────┬────────┘
                          │ Streamable HTTP + bearer │   (only the gateway may reach these:
                          ▼           ▼              ▼    ClusterIP + NetworkPolicy)
                     woo-mcp      notes-mcp      utils-mcp
                          │ REST (wc/v3)
                          ▼
                     wordpress + WooCommerce ──▶ mariadb (PVC)
```

Both the chat agent and external MCP clients go through the gateway's tool router. Nothing else
talks to an upstream.

## WooCommerce MCP server: how it talks to the store, and why

`images/woo-mcp` calls the **WooCommerce REST API (`/wp-json/wc/v3`)** over the cluster network with a
consumer key/secret (HTTP Basic).

Why REST rather than WP-CLI or direct SQL:

| Option | Verdict |
|---|---|
| **REST API** | Official, versioned, validated contract. Product and order creation run through WooCommerce's own business logic (stock, taxes, hooks, emails, caches). Works across a network boundary, so woo-mcp is a tiny separate pod with no access to the database or to WordPress files. Fits least-privilege: the key can be rotated or scoped, and a NetworkPolicy lets the pod talk to exactly one Service. |
| WP-CLI | Needs the WordPress code and DB credentials inside the MCP pod (or `kubectl exec` rights, i.e. a powerful ServiceAccount). Process spawn per call, slow, and much larger blast radius. |
| Direct SQL | Bypasses WooCommerce logic and corrupts caches/order meta. Rejected. |

Details worth knowing:

* WooCommerce only accepts Basic key auth on requests it considers HTTPS. In-cluster traffic is plain
  HTTP, so woo-mcp sends `X-Forwarded-Proto: https` and `wp-config.php` (via `WORDPRESS_CONFIG_EXTRA`)
  maps that header to `$_SERVER['HTTPS']`. That mapping is also what you need anyway behind a
  TLS-terminating ingress in production. Anyone who can reach WordPress can send that header, but they
  still need a valid consumer key.
* The REST key is created by the bootstrap script inside the WordPress image from values that live in a
  Kubernetes Secret (`woo-consumer-key` / `woo-consumer-secret`), so the same secret is read by both pods
  and nothing is stored in an image or in git.
* "Today" is resolved in the store's timezone (`store.timezone`) by the server, so the model only
  has to say `date: "today"`.
* The server is **stateless Streamable HTTP**: every request builds a fresh MCP server instance. Any replica
  can answer any request.

## Gateway

### Tool names and collisions
Every tool is exposed as `<server-slug>__<tool>`: `woo__list_orders`, `notes__ping`, `utils__ping`.

* Slugs are unique (database constraint) and limited to `[a-z0-9-]`, so they never contain `_`; two
  servers exposing the same tool name therefore can never collide, and the prefix tells a model which
  server a tool belongs to.
* Always prefixing (instead of only on collision) keeps names stable: adding a server later never renames
  existing tools and breaks saved prompts.
* Names are sanitized to `[A-Za-z0-9_-]` and capped at 64 characters; longer ones are shortened with a
  deterministic hash suffix.
* The slug is fixed when a server is created (changing it would rename its tools).

### Failure isolation
* `tools/list` is answered from a cache that a background loop refreshes every 10 s (concurrently, each
  server with a 5 s timeout). A dead or slow upstream can therefore never delay listing, and only affects
  its own entry.
* Servers that fail their health check are marked **Unreachable** with the reason (connection refused, DNS
  not found, credential rejected, timeout…) and their tools are hidden, so a model is not offered tools
  that cannot work.
* `tools/call` opens a fresh connection with a hard deadline (30 s default, `gateway.config.callTimeoutMs`)
  and returns an in-band tool error (`isError: true`) such as *Server "x" did not answer in time. Other
  servers are unaffected.* A failed call also flips the server to Unreachable immediately instead of waiting
  for the next poll.
* Disabling a server removes its tools immediately (in-memory state is reset in the same request).

### Sessions and scaling
The MCP endpoint is stateless (`sessionIdGenerator: undefined`, JSON responses): no session lives in a pod, so
nothing is lost on restart and requests can be load-balanced freely. The gateway's *data* is SQLite on a
ReadWriteOnce volume, which is why the chart runs one replica with the `Recreate` strategy. Going beyond
one replica means moving the three small tables that change at runtime (sessions, audit, server status) to
PostgreSQL; the MCP layer already behaves correctly with several replicas. Per-user rate limiting is
per-replica.

## Security model

| Concern | What the code does |
|---|---|
| Upstream credentials | Optional per server: bearer token or custom header. Encrypted at rest with AES-256-GCM (key in a Secret), decrypted only to make an upstream request, never returned by any API, never sent to the browser or MCP clients. After creation not even admins can read them back. |
| API keys | `gw_` + 256 random bits, shown once, stored as SHA-256 hash (+ 11-char prefix for display). Revocation takes effect on the next request. Revoked-key attempts are audited under the key owner. |
| Dashboard login | scrypt password hashes, HttpOnly + SameSite=Lax session cookie (Secure over HTTPS), login throttling, cross-origin writes refused, invitation links are single-use and expire after 7 days. |
| Roles | `admin` (servers, members, all keys, whole audit log) and `member` (tools, chat, own keys, own audit entries). Servers can also mark tools as *admin-only* (comma-separated patterns): hidden from members' tool lists and rejected if called. |
| SSRF | Admin-supplied URLs must be http(s), carry no embedded credentials, and must not resolve to loopback, link-local (169.254.0.0/16 incl. cloud metadata), unspecified, multicast or well-known metadata hostnames. The check runs when saving and again before every connection. Cluster-private ranges are allowed because upstreams live there; set `gateway.config.allowPrivateUpstreams=false` for deployments with public upstreams only. |
| Audit | Every `tools/call` (and rejected authentication) is written with user, source (`mcp` or `chat`), server, tool, duration, outcome and a redacted/truncated argument summary. Outcomes: `success`, `error`, `timeout`, `unreachable`, `rejected`, `rate_limited`. |
| Kubernetes | Non-root containers with read-only root filesystems and all capabilities dropped (gateway, woo-mcp, notes, utils, dashboard); default-deny ingress NetworkPolicy; only the gateway can reach the MCP servers; only WordPress can reach MariaDB; woo-mcp can only egress to WordPress + DNS; upstream Services are ClusterIP with no Ingress. No component uses the Kubernetes API, so there is no RBAC to over-grant. |
| Secrets | All in one Kubernetes Secret (generated on first install and preserved on upgrades, or supplied via `secrets.existingSecret`). Pods consume them via `secretKeyRef`; nothing is in source, images, ConfigMaps or values files. |

## Chat agent
`POST /api/chat` runs an LLM tool loop inside the gateway: it lists the *caller's* tools from the router, lets the model
call them (max 8 steps) and returns the answer together with the list of tool calls (name, arguments, output).
Each call goes through the same router as an external MCP client (same exposure, permissions, timeouts,
rate limit, audit) *as the logged-in user*, with `source = chat`. Providers: `anthropic`, `openai` (any
OpenAI-compatible endpoint: OpenAI, Groq, OpenRouter, Gemini's OpenAI endpoint, Ollama/vLLM for local
models) and a scripted `mock` used only by the tests. The API key is read from the Secret.

## Known limitations
* Gateway is single-replica (see above).
* Credentials support static bearer/header only (no OAuth to upstreams, no OAuth on the gateway itself).
* The invite flow gives the admin a link to hand over instead of sending email.
* NetworkPolicies need a CNI that enforces them (k3s/k3d do; kind's default CNI does not).
* Everything here was developed and tested without a Kubernetes cluster; see README, "What was verified".
