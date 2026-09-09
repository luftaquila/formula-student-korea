import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createViteConfig } from "../../../../shared/build/vite-config.js";

const here = dirname(fileURLToPath(import.meta.url));

export default (env) => ({
  plugins: [vue()],
  // @lib -> competition/modules/traffic/lib (traffic-local module; not cross-service shared)
  ...createViteConfig("traffic", 9500, {
    server: { port: 5173 },
    aliases: { "@lib": resolve(here, "../lib") },
  })(env),
});
