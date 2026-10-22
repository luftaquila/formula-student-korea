import vue from "@vitejs/plugin-vue";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createViteConfig } from "../../shared/build/vite-config.js";

const here = dirname(fileURLToPath(import.meta.url));

// The console shows the fsk-coursekeeper release it was built from: the tag the
// dependency pins, or "dev" for a local link.
const coursekeeperSpec = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")).dependencies["fsk-coursekeeper"];
const coursekeeperVersion = /#(v\d+\.\d+\.\d+)(?:&|$)/.exec(coursekeeperSpec)?.[1] ?? "dev";

// The console comes from the fsk-coursekeeper package as Vue sources. Keep it out
// of dependency pre-bundling and resolve its shared runtimes from this app, so
// the host and the console share one Vue and one Leaflet instance.
export default (env) => {
  const config = createViteConfig("course", 10000, {
    build: {
      rollupOptions: {
        input: { main: resolve(here, "index.html"), public: resolve(here, "public.html") },
      },
    },
  })(env);
  return {
    plugins: [vue()],
    ...config,
    define: { ...config.define, "import.meta.env.VITE_COURSEKEEPER_VERSION": JSON.stringify(coursekeeperVersion) },
    resolve: { ...config.resolve, dedupe: ["vue", "leaflet", "vue-sonner"] },
    optimizeDeps: { exclude: ["fsk-coursekeeper"] },
  };
};
