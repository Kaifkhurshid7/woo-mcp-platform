#!/usr/bin/env bash
# Build all images and import them into the local k3d cluster (no registry needed).
#   IMAGES_ONLY="gateway dashboard" ./scripts/build-images.sh    # rebuild a subset
source "$(dirname "$0")/common.sh"
need docker
build_list=(${IMAGES_ONLY:-${IMAGES[@]}})
for img in "${build_list[@]}"; do
  echo "==> building ${IMAGE_PREFIX}/${img}:${TAG}"
  if [ "${img}" = "provisioner" ]; then
    # The provisioner bakes in the Helm charts, so its build context is the repository root.
    docker build -f "${ROOT}/services/provisioner/Dockerfile" -t "${IMAGE_PREFIX}/${img}:${TAG}" "${ROOT}"
  else
    docker build -t "${IMAGE_PREFIX}/${img}:${TAG}" "${ROOT}/services/${img}"
  fi
done
if [ "${SKIP_IMPORT:-}" != "1" ]; then
  need k3d
  k3d image import -c "${CLUSTER}" $(for i in "${build_list[@]}"; do printf '%s ' "${IMAGE_PREFIX}/${i}:${TAG}"; done)
fi
