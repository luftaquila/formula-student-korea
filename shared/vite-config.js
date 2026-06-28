import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export function createViteConfig(serviceName, servicePort, options = {}) {
  const { entryProxy, server = {}, build = {}, aliases = {} } = options;

  // Resolve @shared relative to the caller's location (two levels up from <service>/web/)
  const sharedDir = resolve(dirname(fileURLToPath(import.meta.url)));

  const proxy = {
    "/api": {
      target: `http://localhost:${servicePort}`,
      changeOrigin: true,
    },
  };

  if (entryProxy) {
    proxy["/entry"] = {
      target: "http://localhost:9200",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/entry/, ""),
    };
  }

  return ({ mode }) => {
    const isProduction = mode === "production";

    return {

      base: isProduction ? `/${serviceName}/` : "",
      server: {
        ...server,
        proxy: {
          ...proxy,
          ...server.proxy,
        },
      },
      build: {
        outDir: "dist",
        emptyOutDir: true,
        ...build,
      },
      resolve: {
        alias: [
          { find: "@shared", replacement: sharedDir },
          // shared/ 모듈(useNotification.js, SonnerToaster.vue)이 bare import 하는
          // vue-sonner 는 web/ 바깥에 있어 rollup 이 해석하지 못한다(vue 와 달리 자동
          // optimizeDeps 대상이 아님). 빌드 cwd(= 각 서비스 web/)의 node_modules 로 고정.
          // 정확히 "vue-sonner" 만 매칭(정규식 $)해야 한다 — 문자열 alias 는 하위 경로
          // "vue-sonner/style.css" 까지 잡아 exports 맵(./lib/index.css)을 우회해 깨진다.
          { find: /^vue-sonner$/, replacement: resolve(process.cwd(), "node_modules/vue-sonner") },
          ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
        ],
      },
    };
  };
}
