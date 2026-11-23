#!/bin/sh
set -eu

chown -R node:node /app/data 2>/dev/null || true
# Renders the site configuration (defaults for unset values); an invalid value stops startup.
node --input-type=module <<'JS'
import modules from "/app/competition/ui-modules.json" with { type: "json" };
import { writeEnvConfig } from "/app/shared/server/write-env-config.mjs";
try {
  writeEnvConfig(Object.values(modules)
    .map((directory) => `/app/competition/modules/${directory}/web/dist/env-config.js`));
} catch (error) {
  console.error(`Invalid site configuration: ${error.message || error}`);
  process.exit(1);
}
JS
exec su-exec node "$@"
