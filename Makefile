# Common tasks. Run `make help`.
SHELL := /bin/bash
.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---- local Kubernetes (k3d) -------------------------------------------------------------
cluster: ## Create the local k3d cluster (Traefik ingress on host port 8080)
	./scripts/k3d-up.sh

images: ## Build all images and import them into the cluster
	./scripts/build-images.sh

deploy: ## helm install/upgrade (LLM_API_KEY=... LLM_PROVIDER=... LLM_MODEL=... are optional)
	./scripts/deploy-local.sh

up: cluster images deploy creds ## Everything: cluster + images + deploy + print logins

creds: ## Print dashboard / WooCommerce logins from the Kubernetes Secret
	./scripts/creds.sh

smoke: ## Smoke-test the running deployment (needs ADMIN_PASSWORD from `make creds`)
	cd tests && npm install --silent && GATEWAY_URL=$${GATEWAY_URL:-http://dash.localtest.me:8080} ADMIN_EMAIL=$${ADMIN_EMAIL:-admin@example.com} ADMIN_PASSWORD=$${ADMIN_PASSWORD:?set ADMIN_PASSWORD} node smoke.mjs

down: ## Delete the release (keeps volumes) 
	helm uninstall $${RELEASE:-shop} -n $${NAMESPACE:-platform}

destroy: ## Delete the whole local cluster and all data
	k3d cluster delete $${CLUSTER:-woo}

# ---- verification without a cluster -----------------------------------------------------
install-deps: ## npm install for every Node package
	for d in images/woo-mcp images/demo-mcp images/gateway images/dashboard tests; do (cd $$d && npm install --silent); done

test: ## Unit tests (Node) for woo-mcp, demo-mcp and the gateway
	for d in images/woo-mcp images/demo-mcp images/gateway; do (cd $$d && npm test --silent) || exit 1; done

e2e: ## End-to-end test of the platform logic with real processes and a fake store
	cd tests && node e2e.mjs

lint-chart: ## helm lint + template for local and prod values (needs helm)
	helm lint charts/platform -f charts/platform/values-local.yaml
	helm lint charts/platform -f charts/platform/values-prod.yaml --set secrets.existingSecret=x
	helm template shop charts/platform -f charts/platform/values-local.yaml > /dev/null
	helm template shop charts/platform -f charts/platform/values-prod.yaml > /dev/null

chart-check: ## Offline structural chart check (when helm is not installed; needs Go + python3-yaml)
	cd tests/chartcheck && go build -o /tmp/chartcheck . && cd .. && python3 chart_check.py

dev: ## Run everything without Kubernetes (fake store, mock chat model, Vite dashboard)
	./scripts/dev.sh

.PHONY: help cluster images deploy up creds smoke down destroy install-deps test e2e lint-chart chart-check dev
