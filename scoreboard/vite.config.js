import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    base: isProduction ? "/scoreboard/" : "",
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        "/traffic/api": {
          target: "http://localhost:9000",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: "./index.html",
      },
    },
    resolve: {
      alias: {
        "@": "/src",
        "@shared": resolve(__dirname, "../shared"),
      },
    },
  };
});
