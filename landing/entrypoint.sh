#!/bin/sh
set -eu
node /opt/site/landing/site-setup.mjs
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
