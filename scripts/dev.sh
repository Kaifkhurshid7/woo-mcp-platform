#!/usr/bin/env bash
# Run the whole platform WITHOUT Kubernetes, for UI work and quick experiments:
#   fake store + woo-mcp + notes + utils + gateway (+ Vite dev server for the dashboard).
# Uses a scripted "mock" chat model unless LLM_PROVIDER/LLM_API_KEY are set. Needs only Node 22.
source "$(dirname "$0")/common.sh"
need node
rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
export WOO_CONSUMER_KEY="ck_$(rnd 12)" WOO_CONSUMER_SECRET="cs_$(rnd 12)"
export T_WOO="$(rnd 12)" T_NOTES="$(rnd 12)" T_UTILS="$(rnd 12)"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(rnd 8)}"
DB="$(mktemp -d)/gateway.db"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
for d in woo-mcp demo-mcp gateway; do [ -d "${ROOT}/images/$d/node_modules" ] || (cd "${ROOT}/images/$d" && npm install --silent); done
PORT=9001 node "${ROOT}/tests/mock-woo.mjs" & pids+=($!)
PORT=9002 MCP_AUTH_TOKEN="$T_WOO" WOO_BASE_URL=http://127.0.0.1:9001 node "${ROOT}/images/woo-mcp/src/server.js" & pids+=($!)
PORT=9003 KIND=notes MCP_AUTH_TOKEN="$T_NOTES" node "${ROOT}/images/demo-mcp/src/server.js" & pids+=($!)
PORT=9004 KIND=utils MCP_AUTH_TOKEN="$T_UTILS" node "${ROOT}/images/demo-mcp/src/server.js" & pids+=($!)
SEED='[{"slug":"woo","name":"WooCommerce store","url":"http://127.0.0.1:9002/mcp","credentialEnv":"T_WOO"},{"slug":"notes","name":"Team notes","url":"http://127.0.0.1:9003/mcp","credentialEnv":"T_NOTES"},{"slug":"utils","name":"Utilities","url":"http://127.0.0.1:9004/mcp","credentialEnv":"T_UTILS"}]'
PORT=8080 DB_PATH="$DB" ENCRYPTION_KEY="$(rnd 16)" ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD="$ADMIN_PASSWORD" SEED_SERVERS="$SEED" \
  ALLOW_LOOPBACK_UPSTREAMS=true LLM_PROVIDER="${LLM_PROVIDER:-mock}" NODE_NO_WARNINGS=1 node "${ROOT}/images/gateway/src/index.js" & pids+=($!)
echo
echo "Gateway API/MCP : http://localhost:8080   (MCP endpoint /mcp)"
echo "Dashboard (Vite): http://localhost:5173"
echo "Sign in as admin@example.com / ${ADMIN_PASSWORD}"
echo "Chat uses the scripted mock model: try 'create product named Mug priced 12', 'orders', 'ping'."
echo
[ -d "${ROOT}/images/dashboard/node_modules" ] || (cd "${ROOT}/images/dashboard" && npm install --silent)
cd "${ROOT}/images/dashboard" && npm run dev -- --host 127.0.0.1
