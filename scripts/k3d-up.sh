#!/usr/bin/env bash
# Create the local Kubernetes cluster: k3d = k3s in Docker, the same distribution the production VPS runs.
# Traefik (ingress) and local-path storage come with k3s; NetworkPolicies are enforced.
# Host port 8080 -> cluster ingress :80, so URLs are http://store.localtest.me:8080 and http://dash.localtest.me:8080
# (*.localtest.me resolves to 127.0.0.1 in public DNS: no /etc/hosts changes).
source "$(dirname "$0")/common.sh"
need docker; need k3d; need kubectl
if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER} "; then
  echo "cluster '${CLUSTER}' already exists"
else
  k3d cluster create "${CLUSTER}" --servers 1 --agents 0 --port "8080:80@loadbalancer" --wait
fi
kubectl config use-context "k3d-${CLUSTER}" >/dev/null
kubectl get nodes
