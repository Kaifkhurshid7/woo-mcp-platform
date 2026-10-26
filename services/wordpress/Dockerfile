# WordPress + WooCommerce + Storefront theme, with an idempotent first-run bootstrap.
# Based on the official image; WooCommerce and the theme are baked in at build time so pods
# start without needing to reach wordpress.org.
FROM wordpress:7-php8.3-apache

ARG WC_VERSION=11.2.1
ARG WP_CLI_VERSION=2.11.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl unzip ca-certificates less; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    wp --info --allow-root >/dev/null

# The base image copies /usr/src/wordpress to /var/www/html on first start (when the volume is empty),
# so anything placed here ends up on the persistent volume.
RUN set -eux; \
    cd /usr/src/wordpress/wp-content; \
    curl -fsSL -o /tmp/wc.zip "https://downloads.wordpress.org/plugin/woocommerce.${WC_VERSION}.zip"; \
    unzip -q /tmp/wc.zip -d plugins; \
    curl -fsSL -o /tmp/sf.zip "https://downloads.wordpress.org/theme/storefront.latest-stable.zip"; \
    unzip -q /tmp/sf.zip -d themes; \
    rm -f /tmp/wc.zip /tmp/sf.zip; \
    chown -R www-data:www-data /usr/src/wordpress/wp-content

# WP-CLI runs as www-data (HOME is not writable) and cannot detect Apache modules, so tell it both.
ENV WP_CLI_CACHE_DIR=/tmp/wp-cli-cache \
    WP_CLI_CONFIG_PATH=/usr/local/share/woo/wp-cli.yml
COPY wp-cli.yml /usr/local/share/woo/wp-cli.yml
COPY bootstrap.sh /usr/local/bin/woo-bootstrap.sh
COPY create-api-key.php /usr/local/share/woo/create-api-key.php
COPY entrypoint.sh /usr/local/bin/woo-entrypoint.sh
RUN chmod +x /usr/local/bin/woo-bootstrap.sh /usr/local/bin/woo-entrypoint.sh

ENTRYPOINT ["woo-entrypoint.sh"]
CMD ["apache2-foreground"]
