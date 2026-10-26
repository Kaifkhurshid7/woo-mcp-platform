#!/usr/bin/env bash
# Shared settings for the helper scripts. Override any of these from the environment.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${CLUSTER:-woo}"
RELEASE="${RELEASE:-shop}"
NAMESPACE="${NAMESPACE:-platform}"
IMAGE_PREFIX="${IMAGE_PREFIX:-woo-platform}"
TAG="${TAG:-dev}"
IMAGES=(wordpress woo-mcp demo-mcp gateway provisioner dashboard)

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not installed" >&2; exit 1; }; }
