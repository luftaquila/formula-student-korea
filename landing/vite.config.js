import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  define: {
    __TEST_SERVER__: process.env.TEST_SERVER === "true",
  },
  server: {
    port: 9000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../shared"),
    },
  },
});
