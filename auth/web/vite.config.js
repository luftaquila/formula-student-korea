import vue from "@vitejs/plugin-vue";
import { createViteConfig, siteEnvConfigPlugin } from "../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue(), siteEnvConfigPlugin()],
  ...createViteConfig("auth", 9100)(env),
});
