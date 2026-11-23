import vue from "@vitejs/plugin-vue";
import { createViteConfig, siteEnvConfigPlugin } from "../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue(), siteEnvConfigPlugin()],
  ...createViteConfig("email", 9900)(env),
});
