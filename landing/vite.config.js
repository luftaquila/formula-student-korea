import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],

  server: {
    port: 9000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: [
      { find: "@shared", replacement: resolve(__dirname, "../shared") },
      // shared/SonnerToaster.vue·useNotification.js 가 bare import 하는 vue-sonner 는
      // landing/ 바깥(shared/)이라 rollup 이 해석 못 한다(landing Docker 엔 node_modules
      // 심링크도 없음). 정확히 매칭(/^vue-sonner$/)해 /style.css 하위 exports 는 건드리지 않는다.
      { find: /^vue-sonner$/, replacement: resolve(__dirname, "node_modules/vue-sonner") },
    ],
  },
});
