import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    base: isProduction ? "/queue/" : "",
    plugins: [vue()],
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:9300",
          changeOrigin: true,
        },
        "/entry": {
          target: "http://localhost:9100",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/entry/, ""),
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
