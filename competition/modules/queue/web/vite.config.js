import vue from "@vitejs/plugin-vue";
import { createViteConfig } from "../../../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("queue", 9300)(env),
});
