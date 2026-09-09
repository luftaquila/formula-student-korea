import vue from "@vitejs/plugin-vue";
import { createViteConfig } from "../../shared/build/vite-config.js";

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("email", 9900)(env),
});
