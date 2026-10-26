#!/usr/bin/env bash
# Build all images and import them into the local k3d cluster (no registry needed).
source "$(dirname "$0")/common.sh"
need docker
for img in "${IMAGES[@]}"; do
  echo "==> building ${IMAGE_PREFIX}/${img}:${TAG}"
  docker build -t "${IMAGE_PREFIX}/${img}:${TAG}" "${ROOT}/images/${img}"
done
if [ "${SKIP_IMPORT:-}" != "1" ]; then
  need k3d
  k3d image import -c "${CLUSTER}" $(for i in "${IMAGES[@]}"; do printf '%s ' "${IMAGE_PREFIX}/${i}:${TAG}"; done)
fi
