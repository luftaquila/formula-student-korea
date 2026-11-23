import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

import { renderLandingIndex, setupSite } from "../../landing/site-setup.mjs";
import { DEFAULT_OG_IMAGE_ALT, parseSiteConfig } from "../../shared/common/site-config.js";
import { SITE_FEATURE_NAMES, isSiteFeature } from "../../shared/common/site-features.js";

const require = createRequire(import.meta.url);
const requireVue = createRequire(require.resolve("vue/package.json"));
const { parse } = requireVue("@vue/compiler-dom");

const TEMPLATE = fs.readFileSync("landing/index.html", "utf8");
const roots = [];

after(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function metadata(html) {
  const result = new Map();
  (function visit(node) {
    if (node.tag === "meta") {
      const attrs = Object.fromEntries(node.props.map((attr) => [attr.name, attr.value?.content]));
      result.set(attrs.property ?? attrs.name, attrs.content);
    }
    for (const child of node.children ?? []) visit(child);
  })(parse(html));
  return result;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-site-setup-"));
  roots.push(root);
  const dirs = {
    indexTemplate: path.join(root, "index.template.html"),
    landingDir: path.join(root, "landing"),
    routesDir: path.join(root, "routes"),
    enabledRoutesDir: path.join(root, "routes.d"),
  };
  fs.mkdirSync(dirs.landingDir);
  fs.writeFileSync(dirs.indexTemplate, TEMPLATE);
  fs.cpSync(path.resolve("landing/routes"), dirs.routesDir, { recursive: true });
  return dirs;
}

test("every packaged route snippet belongs to a site feature", () => {
  const snippets = fs.readdirSync("landing/routes");
  assert.deepEqual(snippets.sort(), ["calendar.caddy", "course.caddy", "email.caddy", "energymeter.caddy", "files.caddy"]);
  for (const file of snippets) assert.ok(isSiteFeature(path.basename(file, ".caddy")), file);
  const caddyfile = fs.readFileSync("landing/Caddyfile", "utf8");
  assert.match(caddyfile, /^\s*import \/etc\/caddy\/routes\.d\/\*\.caddy$/m);
  for (const file of snippets) {
    // Each upstream appears only in its snippet, so a disabled feature has no route.
    const upstream = fs.readFileSync(path.join("landing/routes", file), "utf8").match(/reverse_proxy (\S+)/)[1];
    assert.equal(caddyfile.includes(upstream), false, upstream);
  }
});

test("the unconfigured landing page keeps the FSK title and the packaged host-aware image", () => {
  const html = renderLandingIndex(TEMPLATE, parseSiteConfig({}));
  assert.match(html, /<title>Formula Student Korea<\/title>/);
  assert.doesNotMatch(html, /site-meta/);
  const tags = metadata(html);
  assert.equal(tags.get("og:title"), "Formula Student Korea");
  assert.equal(tags.get("og:site_name"), "Formula Student Korea");
  assert.equal(tags.get("og:locale"), "ko_KR");
  // Caddy fills the request host when it renders the template.
  assert.equal(tags.get("og:image"), "https://{{ .Req.Host | html }}/og-image.png");
  assert.equal(tags.get("twitter:image"), tags.get("og:image"));
  assert.equal(tags.get("og:image:type"), "image/png");
  assert.equal(tags.get("og:image:width"), "1200");
  assert.equal(tags.get("og:image:height"), "630");
  assert.equal(tags.get("og:image:alt"), DEFAULT_OG_IMAGE_ALT);
  assert.equal(tags.get("twitter:card"), "summary_large_image");
});

test("a configured site renders its own name and image without Caddy evaluating its values", () => {
  const site = parseSiteConfig({
    SITE_NAME: "EV {{ .Req.Host }} & <Korea>",
    SITE_OG_IMAGE: "https://cdn.example.org/ev.png",
  });
  const html = renderLandingIndex(TEMPLATE, site);
  assert.match(html, /<title>EV &#123;&#123; \.Req\.Host &#125;&#125; &amp; &lt;Korea&gt;<\/title>/);
  assert.equal(html.match(/\{\{/g), null, "no template action remains for a configured image");
  const tags = metadata(html);
  assert.equal(tags.get("og:image"), "https://cdn.example.org/ev.png");
  assert.equal(tags.has("og:image:width"), false);
  assert.equal(tags.get("og:image:alt"), "EV {{ .Req.Host }} & <Korea>");
});

test("enables the routes of configured features and renders the landing files", () => {
  const dirs = fixture();
  fs.mkdirSync(dirs.enabledRoutesDir);
  fs.writeFileSync(path.join(dirs.enabledRoutesDir, "files.caddy"), "stale");

  const result = setupSite({ ...dirs, env: { SITE_NAME: "EV Student Korea", FEATURES: "entry,registration,email,calendar" } });
  assert.deepEqual(result.enabledRoutes, ["calendar", "email"]);
  assert.deepEqual(fs.readdirSync(dirs.enabledRoutesDir).sort(), ["calendar.caddy", "email.caddy"]);
  assert.equal(fs.readFileSync(path.join(dirs.enabledRoutesDir, "email.caddy"), "utf8"),
    fs.readFileSync("landing/routes/email.caddy", "utf8"));
  assert.match(fs.readFileSync(path.join(dirs.landingDir, "index.html"), "utf8"), /<title>EV Student Korea<\/title>/);

  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(dirs.landingDir, "env-config.js"), "utf8"), { window });
  assert.equal(window.__SITE__.name, "EV Student Korea");
  assert.equal(window.__SITE__.shortName, "FSK");
  assert.deepEqual([...window.__SITE__.features], ["entry", "registration", "calendar", "email"]);

  // Rendering again starts from the pristine template, as in a restarted container.
  const unconfigured = setupSite({ ...dirs, env: {} });
  assert.deepEqual(unconfigured.site.features, SITE_FEATURE_NAMES);
  assert.deepEqual(unconfigured.enabledRoutes, ["calendar", "course", "email", "energymeter", "files"]);
  assert.match(fs.readFileSync(path.join(dirs.landingDir, "index.html"), "utf8"), /<title>Formula Student Korea<\/title>/);
});

test("fails before Caddy starts on an invalid value or snippet", () => {
  const dirs = fixture();
  assert.throws(() => setupSite({ ...dirs, env: { FEATURES: "entry,course,maps" } }), /unknown features: maps/);
  assert.equal(fs.existsSync(path.join(dirs.landingDir, "index.html")), false);
  assert.equal(fs.existsSync(path.join(dirs.landingDir, "env-config.js")), false);

  fs.writeFileSync(path.join(dirs.routesDir, "maps.caddy"), "");
  assert.throws(() => setupSite({ ...dirs, env: {} }), /maps\.caddy does not name a site feature/);
  assert.throws(() => renderLandingIndex("<html><head></head></html>", parseSiteConfig({})), /site-meta marker/);
});
