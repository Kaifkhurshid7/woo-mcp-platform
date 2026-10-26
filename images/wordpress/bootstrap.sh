#!/bin/bash
# Idempotent store setup. Safe to run on every container start.
#   - waits for wp-config.php (written by the official entrypoint) and for the database
#   - installs WordPress if needed, activates WooCommerce + Storefront
#   - makes the shop usable: pages, Cash on Delivery, a shipping method, store not "coming soon"
#   - provisions the REST API key that woo-mcp uses, from values supplied by a Kubernetes Secret
set -uo pipefail

WWW=/var/www/html
WP() { runuser -u www-data -- wp --path="$WWW" "$@"; }

: "${WP_SITE_URL:?WP_SITE_URL is required}"
: "${WP_ADMIN_USER:=shopadmin}"
: "${WP_ADMIN_EMAIL:=admin@example.com}"
: "${WP_SITE_TITLE:=Demo Store}"
: "${WC_CURRENCY:=USD}"
: "${WC_COUNTRY:=US:CA}"
: "${WORDPRESS_DB_HOST:=mariadb}"
DB_HOST="${WORDPRESS_DB_HOST%%:*}"
DB_PORT="${WORDPRESS_DB_HOST##*:}"; [ "$DB_PORT" = "$WORDPRESS_DB_HOST" ] && DB_PORT=3306

bootstrap_once() {
  until [ -f "$WWW/wp-config.php" ] && [ -f "$WWW/wp-includes/version.php" ]; do sleep 1; done

  echo "waiting for database $DB_HOST:$DB_PORT"
  until php -r 'mysqli_report(MYSQLI_REPORT_OFF); $c=@new mysqli($argv[1],$argv[2],$argv[3],$argv[4],(int)$argv[5]); exit($c->connect_errno?1:0);' \
        "$DB_HOST" "$WORDPRESS_DB_USER" "$WORDPRESS_DB_PASSWORD" "$WORDPRESS_DB_NAME" "$DB_PORT"; do sleep 2; done

  if ! WP core is-installed 2>/dev/null; then
    echo "installing WordPress"
    WP core install --url="$WP_SITE_URL" --title="$WP_SITE_TITLE" --admin_user="$WP_ADMIN_USER" \
       --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email || return 1
  fi

  # Keep these in sync with Helm values on every start (domain changes between local and prod).
  WP option update home "$WP_SITE_URL" >/dev/null
  WP option update siteurl "$WP_SITE_URL" >/dev/null
  WP option update blogname "$WP_SITE_TITLE" >/dev/null

  WP plugin activate woocommerce || return 1
  WP theme activate storefront || return 1
  WP rewrite structure '/%postname%/' --hard >/dev/null || return 1   # needed for /wp-json/ REST routes

  # --- WooCommerce basics ---
  WP option update woocommerce_currency "$WC_CURRENCY" >/dev/null
  WP option update woocommerce_default_country "$WC_COUNTRY" >/dev/null
  WP option update woocommerce_coming_soon no >/dev/null          # storefront must be public
  WP option update woocommerce_store_pages_only no >/dev/null
  WP option update woocommerce_onboarding_opt_in no >/dev/null 2>&1 || true
  WP option update woocommerce_allow_tracking no >/dev/null
  WP option update woocommerce_cod_settings \
     '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash when your order is delivered.","instructions":"Pay with cash when your order is delivered.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
     --format=json >/dev/null
  WP wc tool run install_pages --user="$WP_ADMIN_USER" >/dev/null 2>&1 || true   # shop, cart, checkout, my account

  # Physical products need a shipping method or checkout is blocked: add free shipping to "Rest of the world".
  if [ "$(WP wc shipping_zone_method list 0 --user="$WP_ADMIN_USER" --format=count 2>/dev/null || echo 0)" = "0" ]; then
    WP wc shipping_zone_method create 0 --method_id=free_shipping --user="$WP_ADMIN_USER" >/dev/null || return 1
  fi

  # One sample product so a fresh storefront can be shopped immediately (skipped once any product exists).
  if [ "$(WP post list --post_type=product --post_status=any --format=count 2>/dev/null || echo 1)" = "0" ]; then
    WP wc product create --name="Sample Coffee Mug" --type=simple --regular_price=12.00 --status=publish \
       --description="A sample product created by the bootstrap script." --user="$WP_ADMIN_USER" >/dev/null || return 1
  fi

  # REST credentials for woo-mcp (values come from the Kubernetes Secret, never from the image).
  if [ -n "${WOO_CONSUMER_KEY:-}" ] && [ -n "${WOO_CONSUMER_SECRET:-}" ]; then
    WP eval-file /usr/local/share/woo/create-api-key.php "$WP_ADMIN_USER" || return 1
  fi
  return 0
}

for attempt in $(seq 1 60); do
  if bootstrap_once; then
    touch /tmp/bootstrap-done
    echo "store is ready at $WP_SITE_URL"
    exit 0
  fi
  echo "bootstrap attempt $attempt failed, retrying in 5s"
  sleep 5
done
touch /tmp/bootstrap-failed
echo "bootstrap failed after 60 attempts"
exit 1
