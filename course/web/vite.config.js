import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createViteConfig } from "../../shared/build/vite-config.js";

const here = dirname(fileURLToPath(import.meta.url));

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
    resolve: { ...config.resolve, dedupe: ["vue", "leaflet", "vue-sonner"] },
    optimizeDeps: { exclude: ["fsk-coursekeeper"] },
  };
};
