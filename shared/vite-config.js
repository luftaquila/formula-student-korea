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
        alias: {
          "@shared": sharedDir,
          ...aliases,
        },
      },
    };
  };
}
