#!/bin/sh
set -eu

chown -R node:node /app/data 2>/dev/null || true
node --input-type=module <<'JS'
import fs from "node:fs";
import modules from "/app/competition/ui-modules.json" with { type: "json" };
for (const directory of Object.values(modules)) {
  const config = `/app/competition/modules/${directory}/web/dist/env-config.js`;
  fs.writeFileSync(config, `window.__TEST_SERVER__ = ${process.env.TEST_SERVER || "false"};\n`);
}
JS
exec su-exec node "$@"
