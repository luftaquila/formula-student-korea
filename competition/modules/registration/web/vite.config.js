import vue from "@vitejs/plugin-vue";
import { createViteConfig } from "../../../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("registration", 9200)(env),
});
