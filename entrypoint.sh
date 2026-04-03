#!/bin/sh
chown -R node:node data 2>/dev/null || true
echo "window.__TEST_SERVER__ = ${TEST_SERVER:-false};" > web/dist/env-config.js
exec "$@"
