<?php
// Usage: wp eval-file create-api-key.php <admin-login>
// Registers the WooCommerce REST consumer key/secret provided through the environment so that the
// woo-mcp pod can authenticate. Idempotent: replaces any previous key with description "woo-mcp".
global $wpdb;
$login = $args[0] ?? '';
$user  = get_user_by('login', $login);
if (!$user) { WP_CLI::error("admin user '$login' not found"); }

$ck = getenv('WOO_CONSUMER_KEY');
$cs = getenv('WOO_CONSUMER_SECRET');
if (!$ck || !$cs || strpos($ck, 'ck_') !== 0 || strpos($cs, 'cs_') !== 0) {
    WP_CLI::error('WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET must start with ck_ / cs_');
}

$table = $wpdb->prefix . 'woocommerce_api_keys';
$wpdb->delete($table, array('description' => 'woo-mcp'));
$ok = $wpdb->insert($table, array(
    'user_id'         => $user->ID,
    'description'     => 'woo-mcp',
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($ck),   // WooCommerce stores the key hashed...
    'consumer_secret' => $cs,                // ...and the secret as-is
    'truncated_key'   => substr($ck, -7),
));
if (!$ok) { WP_CLI::error('could not insert API key: ' . $wpdb->last_error); }
WP_CLI::success('REST API key for woo-mcp is in place');
