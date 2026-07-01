import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createViteConfig } from "../../shared/vite-config.js";

const here = dirname(fileURLToPath(import.meta.url));

export default (env) => ({
  plugins: [vue()],
  // @lib -> course/lib (course-local isomorphic modules; not cross-service shared)
  ...createViteConfig("course", 10000, {
    aliases: { "@lib": resolve(here, "../lib") },
  })(env),
});
