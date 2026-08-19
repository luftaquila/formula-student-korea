#!/bin/sh
set -eu

chown -R node:node /app/data 2>/dev/null || true
for service in entry queue inspection traffic score documents; do
  config="/app/$service/web/dist/env-config.js"
  printf 'window.__TEST_SERVER__ = %s;\n' "${TEST_SERVER:-false}" > "$config"
done
exec su-exec node "$@"
