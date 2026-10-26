#!/usr/bin/env bash
# Create the platform Secret out-of-band for production (values-prod.yaml sets secrets.existingSecret).
# Random values are generated locally; nothing is written to disk. Optional: LLM_API_KEY, ADMIN_PASSWORD.
#   NAMESPACE=platform SECRET=woo-platform-secrets LLM_API_KEY=sk-... ./scripts/create-secret.sh
source "$(dirname "$0")/common.sh"
need kubectl; need openssl
SECRET="${SECRET:-woo-platform-secrets}"
rnd() { openssl rand -hex "$1"; }
kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${NAMESPACE}"
kubectl -n "${NAMESPACE}" create secret generic "${SECRET}" \
  --from-literal=mariadb-root-password="$(rnd 16)" \
  --from-literal=mariadb-password="$(rnd 16)" \
  --from-literal=wp-admin-password="$(rnd 12)" \
  --from-literal=woo-consumer-key="ck_$(rnd 20)" \
  --from-literal=woo-consumer-secret="cs_$(rnd 20)" \
  --from-literal=woo-mcp-token="$(rnd 20)" \
  --from-literal=notes-mcp-token="$(rnd 20)" \
  --from-literal=utils-mcp-token="$(rnd 20)" \
  --from-literal=gateway-encryption-key="$(rnd 24)" \
  --from-literal=internal-token="$(rnd 24)" \
  --from-literal=postgres-password="$(rnd 16)" \
  --from-literal=gateway-admin-password="${ADMIN_PASSWORD:-$(rnd 12)}" \
  --from-literal=llm-api-key="${LLM_API_KEY:-}"
echo "Secret ${NAMESPACE}/${SECRET} created. Read the admin logins with:"
echo "  SECRET=${SECRET} ./scripts/creds.sh"
