import uiModules from "../../competition/ui-modules.json" with { type: "json" };
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { createViteConfig } from "../../shared/build/vite-config.js";

const requireWeb = createRequire(new URL("../../competition/modules/inspection/web/package.json", import.meta.url));
const { createServer, build } = await import(requireWeb.resolve("vite"));
const { default: vue } = await import(requireWeb.resolve("@vitejs/plugin-vue"));
const root = new URL("../../", import.meta.url).pathname;

function bannerContext(enabled) {
  let notifyTitle;
  const children = [];
  const document = {
    title: "FSK Example",
    documentElement: { classList: { add() {} } },
    head: { appendChild(node) { children.push(node); } },
    createElement() { return {}; },
    querySelector(selector) { return selector === "title" ? {} : null; },
  };
  const context = vm.createContext({
    window: { __TEST_SERVER__: enabled }, document,
    MutationObserver: class {
      constructor(callback) { notifyTitle = callback; }
      observe() {}
    },
  });
  return { context, document, children, notify: () => notifyTitle() };
}

const source = (await readFile(new URL("../../shared/browser/test-banner.js", import.meta.url), "utf8"))
  .replace("export function", "function");

test("test titles retain the warning after navigation without duplicate prefixes", () => {
  const page = bannerContext(true);
  vm.runInContext(`${source}\ninitTestBanner();`, page.context);
  assert.equal(page.document.title, "TEST FSK Example");
  page.document.title = "FSK Next page";
  page.notify();
  page.notify();
  assert.equal(page.document.title, "TEST FSK Next page");
});

test("titles leave the warning glyph to the favicon", () => {
  const page = bannerContext(true);
  vm.runInContext(`${source}\ninitTestBanner();`, page.context);
  assert.doesNotMatch(page.document.title, /⚠️/);
  assert.match(page.children.at(-1).href, /%E2%9A%A0%EF%B8%8F/);
});

test("live pages keep their title and favicon", () => {
  const page = bannerContext(false);
  vm.runInContext(`${source}\ninitTestBanner();`, page.context);
  assert.equal(page.document.title, "FSK Example");
  assert.equal(page.children.length, 0);
});

test("runtime settings resolve to the application root on direct nested visits", async (t) => {
  for (const service of ["auth", "entry", "queue", "registration", "inspection", "traffic", "score", "documents", "course", "calendar", "email", "landing"]) {
    await t.test(service, async () => {
      // Exercise Vite's production HTML transform; JS bundles are irrelevant
      // to the URL the browser uses to load runtime settings.
      const base = service === "landing" ? "/" : `/${service}/`;
      const result = await build({
        ...createViteConfig(service, 9000)({ mode: "production" }),
        base, root: `${root}${uiModules[service] ? `competition/modules/${uiModules[service]}/web` : service === "landing" ? service : `${service}/web`}`,
        configFile: false, logLevel: "silent",
        build: { write: false, rollupOptions: { external: (id) => !id.endsWith(".html") } },
      });
      const html = result.output.find((asset) => asset.fileName === "index.html").source;
      const src = html.match(/src="([^"]*env-config\.js)"/)[1];
      assert.equal(new URL(src, `https://example.invalid/${service}/nested/page`).pathname,
        `${base}env-config.js`);
    });
  }
});

test("standalone notice identifies test screens and is absent on live screens", async () => {
  const server = await createServer({
    root, configFile: false, plugins: [vue()],
    server: { middlewareMode: true, watch: null },
  });
  const previousWindow = globalThis.window;
  try {
    const { default: Notice } = await server.ssrLoadModule("/shared/browser/TestServerNotice.vue");
    globalThis.window = { __TEST_SERVER__: true };
    assert.match(await renderToString(createSSRApp(Notice)), /⚠️ TEST/);
    globalThis.window = { __TEST_SERVER__: false };
    assert.doesNotMatch(await renderToString(createSSRApp(Notice)), /⚠️ TEST/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
