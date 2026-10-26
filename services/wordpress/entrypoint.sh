#!/bin/bash
# Start the store bootstrap in the background, then hand over to the official entrypoint
# (which copies WordPress into the volume, writes wp-config.php from env, and starts Apache).
set -euo pipefail
rm -f /tmp/bootstrap-done /tmp/bootstrap-failed
/usr/local/bin/woo-bootstrap.sh > >(sed -u 's/^/[bootstrap] /') 2>&1 &
exec docker-entrypoint.sh "$@"
