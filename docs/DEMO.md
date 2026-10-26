# Demo walkthrough (the "definition of done")

Prerequisites: Docker, `k3d`, `kubectl`, `helm`, Node 22. A chat model key is only needed for the chat steps; without one, deploy with
`LLM_PROVIDER=mock` and the scripted model will drive the same tool loop.

```bash
export LLM_API_KEY=sk-...       # optional; never committed: Helm puts it in the cluster Secret
make up                         # k3d cluster + images + helm install + prints logins (about 10 minutes the first time)
```

`make creds` prints the generated logins at any time.

| What              | URL                                                   |
| ----------------- | ----------------------------------------------------- |
| Storefront        | http://store.localtest.me:8080                        |
| WooCommerce admin | http://store.localtest.me:8080/wp-admin (`shopadmin`) |
| Dashboard         | http://dash.localtest.me:8080 (`admin@example.com`)   |
| MCP endpoint      | http://dash.localtest.me:8080/mcp                     |

`*.localtest.me` is public wildcard DNS for `127.0.0.1`, so no `/etc/hosts` edit is required; k3d publishes the ingress on host port 8080.

**Automated version of everything below:** `make demo` (core flow), `make demo-stores` (plus multi-store), `make demo-hosted`,
`make demo-replicas`. Each prints one `ok` line per check. The rest of this page is the same flow by hand.

## 1. Store

1. Open the storefront. A sample product ("Sample Coffee Mug") exists. Add it to the cart and check out with **Cash on delivery**.
2. Open WooCommerce admin, _WooCommerce > Orders_: the order is there.

## 2. Team setup (admin)

Sign in to the dashboard as the admin.

- **Servers** shows `woo` (WooCommerce store, first), `notes` and `utils`, all _Connected_, with their tools (expand _Tools_).
- **Team > Invite**: create `a@example.com` and `b@example.com` as members. Copy each invite link, open it in a private window and set a password.
- As user A and user B, open **API keys > Generate key**. The key is shown once, with ready-made snippets for Claude Code, Cursor and MCP Inspector.

## 3. Chat agent as user A

In **Chat**:

1. _Create a product called "Filter Coffee 250g" priced at 349._ The tool trace shows `woo__create_product` and the product is on the storefront.
2. On the storefront, buy it (COD).
3. _What orders came in today?_ The trace shows `woo__list_orders` and the answer contains your order.

## 4. External MCP client as user B

Use only the gateway URL and B's key.

```bash
# Claude Code
claude mcp add --transport http team-gateway http://dash.localtest.me:8080/mcp \
  --header "Authorization: Bearer <B's key>"

# or MCP Inspector (Transport: Streamable HTTP, header Authorization: Bearer <key>)
npx @modelcontextprotocol/inspector
```

- The tool list contains every enabled server's tools: `woo__*`, `notes__*`, `utils__*`. Note `notes__ping` and `utils__ping`: same upstream
  name, no collision.
- Ask _What orders came in today?_ and get the same order.
- A two-server prompt: _"Find the price of the Filter Coffee product in the store, add 18% tax with the calculator, and save the result
  as a note."_ uses `woo__list_products`, `utils__calculate` and `notes__add_note`.
- **Browser login instead of a key:** clients that support OAuth only need the URL. The gateway answers 401 with a pointer to its
  OAuth metadata, the client opens a login page, and the resulting token behaves like an API key. Disconnect it from **API keys**.
- **Many tools:** point a client at `/mcp/search` to see three tools (`search_tools`, `describe_tool`, `call_tool`) instead of every tool.

## 5. Control

Dashboard as admin:

1. **Team > All API keys > Revoke** B's key. Run any tool in B's client: HTTP 401 "This API key has been revoked."
2. **Servers > Disable** `utils`. Its tools vanish from the chat and from B's client; calling one is rejected. Enable it again.
3. Kill an upstream pod:
   ```bash
   kubectl -n platform scale deploy/shop-notes-mcp --replicas=0      # or: kubectl -n platform delete pod -l app.kubernetes.io/name=notes-mcp
   ```
   Within about 10 s (immediately after a failed call) **Servers** shows `notes` as _Unreachable_ with the reason, while woo and utils keep
   working. Scale it back to 1 and it returns to _Connected_.
4. **Audit log** lists every call above: user, via (chat or mcp), server, tool, duration, outcome. The revoked-key attempt appears as
   `rejected` under B. **Metrics** shows calls, error rate and latency per server.

## 6. More stores

1. Dashboard > **Stores**, enter a name, **Create store**. The row goes Provisioning, then Ready after a few minutes (WordPress installs
   itself). Create a second one while the first is still provisioning.
2. A third store for the same user is refused (the per-user limit). Pressing the button twice, or retrying, does not create duplicates.
3. In **Servers**, each store appears as `store-<name>` with its own tools. In **Chat**: _compare today's orders in store-alpha and
   store-beta_ (with a real model; the mock one only does single-tool prompts).
4. Isolation:
   ```bash
   kubectl -n store-<id-a> exec deploy/store-woo-mcp -- wget -q -T 4 -O - http://store-wordpress/wp-login.php | head -c 80      # works
   kubectl -n store-<id-a> exec deploy/store-woo-mcp -- wget -q -T 4 -O - http://store-wordpress.store-<id-b>.svc.cluster.local/   # blocked
   ```
5. **Delete** a store. Its namespace, PVCs, Secrets, Ingress and tools disappear: `kubectl get ns,pvc -A | grep store-`.
6. Restart safety: `kubectl -n platform rollout restart deploy/shop-provisioner` during provisioning. The store either completes or is
   marked Failed with a reason.

## 7. Hosted MCP server

**Servers > Host from image**: image `woo-platform/demo-mcp:dev`, environment `KIND=utils`. The platform creates `mcpx-<id>` with its Secret,
quota and NetworkPolicy, and registers the tools. Delete it from the **Hosted from image** table to remove everything.

## 8. Replicas, upgrade and rollback

```bash
helm upgrade shop charts/platform -n platform -f charts/platform/values-local.yaml \
  --set postgres.enabled=true --set gateway.replicas=2 --wait          # then: make demo-replicas
helm upgrade shop charts/platform -n platform -f charts/platform/values-local.yaml \
  --set postgres.enabled=true --set gateway.replicas=2 --set gateway.config.rateLimitPerMin=60 --wait
helm rollback shop -n platform --wait                                    # back to the previous revision
```

Add `--set llm.provider=mock` (or your provider and key) to every `helm upgrade`, or the chart's defaults are used.

## Things to try

- **Tool permissions:** edit `woo` and set _Admin-only tools_ to `create_*, update_order_status`; members can no longer see or call them.
- **Timeouts:** point a server at something that hangs; the call fails after `callTimeoutMs` with a clear message.
- **SSRF guard:** try adding `http://169.254.169.254/latest/meta-data` as a server: rejected.
- **Metrics:** `kubectl -n platform port-forward svc/shop-gateway 8081:8080`, then `curl localhost:8081/metrics`.
