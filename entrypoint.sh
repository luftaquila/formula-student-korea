#!/bin/sh
chown -R node:node data 2>/dev/null || true
exec "$@"
