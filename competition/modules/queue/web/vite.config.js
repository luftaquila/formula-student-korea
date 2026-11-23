import vue from "@vitejs/plugin-vue";
import { createViteConfig, siteEnvConfigPlugin } from "../../../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue(), siteEnvConfigPlugin()],
  ...createViteConfig("queue", 9300)(env),
});
