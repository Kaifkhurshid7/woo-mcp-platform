# Demo walkthrough (the "definition of done")

Prerequisites: Docker, `k3d`, `kubectl`, `helm`, Node 22 (for the optional smoke test).
A chat model key is needed only for the chat-agent steps.

```bash
# any provider works; Anthropic shown. For Groq/OpenRouter/Gemini/Ollama use LLM_PROVIDER=openai + LLM_BASE_URL + LLM_MODEL.
export LLM_API_KEY=sk-...            # never committed: Helm puts it in the cluster Secret
make up                              # k3d cluster + images + helm install + prints logins (~5-10 min first time)
```

`make creds` prints the generated logins at any time:

| What | URL |
|---|---|
| Storefront | http://store.localtest.me:8080 |
| WooCommerce admin | http://store.localtest.me:8080/wp-admin (`shopadmin`) |
| Dashboard | http://dash.localtest.me:8080 (`admin@example.com`) |
| MCP endpoint | http://dash.localtest.me:8080/mcp |

`*.localtest.me` is a public wildcard DNS record pointing at `127.0.0.1`, so no `/etc/hosts` edit is required;
k3d publishes the cluster's ingress on host port 8080.

Quick automated check of the deployed system: `ADMIN_PASSWORD=<from make creds> make smoke`.

## 1. Store
1. Open the storefront. A sample product ("Sample Coffee Mug") exists. Add it to the cart and check out with **Cash on delivery**.
2. Open WooCommerce admin → *WooCommerce → Orders*: the order is there.

## 2. Team setup (admin)
Sign in to the dashboard as the admin.
* **Servers** shows `woo` (WooCommerce store, first), `notes` and `utils`, all *Connected*, with their tools (expand *Tools*).
* **Team → Invite**: create `a@example.com` and `b@example.com` as members. Copy each invite link, open it in a private window, set a password.
* As user A and user B, open **API keys → Generate key**. The key is shown once with ready-made snippets for Claude Code, Cursor and MCP Inspector.

## 3. Chat agent as user A
In **Chat**:
1. *Create a product called "Filter Coffee 250g" priced at 349.* → the tool trace shows `woo__create_product`; the product is on the storefront.
2. On the storefront, buy it (COD).
3. *What orders came in today?* → trace shows `woo__list_orders` and the answer contains your order.

## 4. External MCP client as user B
Use only the gateway URL and B's key.

```bash
# Claude Code
claude mcp add --transport http team-gateway http://dash.localtest.me:8080/mcp \
  --header "Authorization: Bearer <B's key>"

# or MCP Inspector (Transport: Streamable HTTP, header Authorization: Bearer <key>)
npx @modelcontextprotocol/inspector
```
* The tool list contains every enabled server's tools: `woo__*`, `notes__*`, `utils__*`. Note `notes__ping` and `utils__ping`: same upstream tool name, no collision.
* Ask *What orders came in today?* → same order.
* A two-server prompt: *"Find the price of the Filter Coffee product in the store, add 18% tax with the calculator, and save the result as a note."* uses `woo__list_products`, `utils__calculate` and `notes__add_note`.

## 5. Control
Dashboard as admin:
1. **Team → All API keys → Revoke** B's key. Run any tool in B's client: HTTP 401 "This API key has been revoked."
2. **Servers → Disable** `utils`. Its tools vanish from the chat and (on re-list) from B's client; calling one is rejected. Enable it again.
3. Kill an upstream pod:
   ```bash
   kubectl -n platform delete pod -l app.kubernetes.io/name=notes-mcp --grace-period=0 --force
   ```
   Within ~10 s (immediately after a failed call) **Servers** shows `notes` as *Unreachable* with the reason, while woo and utils keep working. Kubernetes restarts the pod and it returns to *Connected* on its own.
4. **Audit log** lists every call above: user, via (chat/mcp), server, tool, duration, outcome. The revoked-key attempt appears as `rejected` under B.

## Things to try
* **Tool permissions:** edit `woo` and set *Admin-only tools* to `create_*, update_order_status`; members no longer see or can call them, admins still can.
* **Timeouts:** point a server at something that hangs; the call fails after `callTimeoutMs` with a clear message and other servers are unaffected.
* **SSRF guard:** try adding `http://169.254.169.254/latest/meta-data` as a server: rejected.
* **Metrics:** `kubectl -n platform port-forward svc/shop-gateway 8080:8080` then `curl localhost:8080/metrics` (calls, outcomes, latency and up/down per server).
