import vue from "@vitejs/plugin-vue";
import { createViteConfig } from "../../shared/vite-config.js";

export default (env) => ({
  plugins: [vue()],
  ...createViteConfig("traffic", 9200, {
    entryProxy: true,
    server: { port: 5173 },
    build: { rollupOptions: { input: "./index.html" } },
    aliases: { "@": "/src" },
  })(env),
});
