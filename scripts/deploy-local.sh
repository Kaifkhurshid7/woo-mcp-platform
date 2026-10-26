#!/usr/bin/env bash
# Install/upgrade the chart on the local cluster.
#   LLM_API_KEY=... [LLM_PROVIDER=anthropic|openai] [LLM_MODEL=...] [LLM_BASE_URL=...] ./scripts/deploy-local.sh
# The API key is passed on the command line to Helm, which stores it in the cluster Secret.
# It is never written to a file in this repository.
source "$(dirname "$0")/common.sh"
need helm; need kubectl
args=(upgrade --install "${RELEASE}" "${ROOT}/charts/platform" --namespace "${NAMESPACE}" --create-namespace
      -f "${ROOT}/charts/platform/values-local.yaml" --wait --timeout 15m)
[ -n "${LLM_PROVIDER:-}" ] && args+=(--set "llm.provider=${LLM_PROVIDER}")
[ -n "${LLM_MODEL:-}" ]    && args+=(--set "llm.model=${LLM_MODEL}")
[ -n "${LLM_BASE_URL:-}" ] && args+=(--set "llm.baseUrl=${LLM_BASE_URL}")
[ -n "${LLM_API_KEY:-}" ]  && args+=(--set "secrets.llmApiKey=${LLM_API_KEY}")
helm "${args[@]}"
