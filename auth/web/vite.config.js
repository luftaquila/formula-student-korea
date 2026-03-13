import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    base: isProduction ? "/auth/" : "",
    plugins: [vue()],
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:9800",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../../shared"),
      },
    },
  };
});
