#!/bin/sh
echo "window.__TEST_SERVER__ = ${TEST_SERVER:-false};" > /srv/landing/env-config.js
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
