#!/bin/sh
set -eu
chown -R node:node data 2>/dev/null || true
# Renders the site configuration (defaults for unset values); an invalid value stops startup.
node ../shared/server/write-env-config.mjs web/dist/env-config.js
echo "window.__VWORLD_KEY__ = \"${VWORLD_KEY:-}\";" >> web/dist/env-config.js
exec "$@"
