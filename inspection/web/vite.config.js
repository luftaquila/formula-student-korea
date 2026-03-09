import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    base: isProduction ? "/inspection/" : "",
    plugins: [vue()],
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:9600",
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
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../../shared"),
      },
    },
  };
});
