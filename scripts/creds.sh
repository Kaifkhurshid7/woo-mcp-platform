#!/usr/bin/env bash
# Print the generated logins from the Kubernetes Secret.
source "$(dirname "$0")/common.sh"
need kubectl
SECRET="${SECRET:-${RELEASE}-secrets}"
get() { kubectl -n "${NAMESPACE}" get secret "${SECRET}" -o "jsonpath={.data.$1}" | base64 -d; }
HOST_PORT="${HOST_PORT:-:8080}"
echo "Dashboard        http://dash.localtest.me${HOST_PORT}"
echo "  admin email    $(kubectl -n "${NAMESPACE}" get cm "${RELEASE}-gateway" -o 'jsonpath={.data.ADMIN_EMAIL}')"
echo "  admin password $(get gateway-admin-password)"
echo "Storefront       http://store.localtest.me${HOST_PORT}"
echo "WooCommerce admin http://store.localtest.me${HOST_PORT}/wp-admin"
echo "  user           shopadmin"
echo "  password       $(get wp-admin-password)"
