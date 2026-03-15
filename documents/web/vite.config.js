import vue from "@vitejs/plugin-vue";
import { createViteConfig } from "../../shared/vite-config.js";

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("documents", 9900, { entryProxy: true })(env),
});
