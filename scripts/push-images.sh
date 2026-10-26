#!/usr/bin/env bash
# Build and push images to a registry for the VPS deployment.
#   REGISTRY=ghcr.io/acme TAG=1.0.0 ./scripts/push-images.sh
source "$(dirname "$0")/common.sh"
need docker
: "${REGISTRY:?set REGISTRY, e.g. ghcr.io/acme}"
for img in "${IMAGES[@]}"; do
  ref="${REGISTRY}/${IMAGE_PREFIX}/${img}:${TAG}"
  if [ "${img}" = "provisioner" ]; then docker build -f "${ROOT}/services/provisioner/Dockerfile" -t "${ref}" "${ROOT}"; else docker build -t "${ref}" "${ROOT}/services/${img}"; fi
  docker push "${ref}"
done
echo "Pushed. Set global.imageRegistry=${REGISTRY} and image tags=${TAG} in values-prod.yaml."
