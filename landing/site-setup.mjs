#!/usr/bin/env node
// Runs in the Caddy image before Caddy starts. It reads the deployment's site
// configuration (unset values take the defaults), renders the landing page's title
// and social tags, writes its env-config.js, and enables the route snippets of the
// configured features. An invalid value exits non-zero before Caddy listens.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "../shared/common/escape-html.js";
import { parseSiteConfig, renderEnvConfig } from "../shared/common/site-config.js";
import { isSiteFeature } from "../shared/common/site-features.js";
import { socialMetaTags } from "../shared/common/social-meta.js";

const SITE_META_MARKER = /<!--\s*site-meta\b[\s\S]*?-->/;

// Caddy renders index.html as a template on each request, so the request host
// fills the packaged image URL there. Configured values are escaped for HTML and
// their braces encoded so Caddy never evaluates them.
const REQUEST_ORIGIN = "\u0000origin\u0000";

function escapeTemplateText(value) {
  return escapeHtml(value).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

export function renderLandingIndex(template, site) {
  if (!SITE_META_MARKER.test(template)) throw new Error("landing index.html has no site-meta marker");
  const head = [
    `<title>${escapeTemplateText(site.name)}</title>`,
    ...socialMetaTags({ title: site.name, site, origin: REQUEST_ORIGIN }).map(([attribute, key, value]) =>
      `<meta ${attribute}="${key}" content="${escapeTemplateText(value)}">`),
  ].join("\n    ").replaceAll(REQUEST_ORIGIN, "https://{{ .Req.Host | html }}");
  return template.replace(SITE_META_MARKER, () => head);
}

export function setupSite({ env, indexTemplate, landingDir, routesDir, enabledRoutesDir }) {
  const site = parseSiteConfig(env);
  const index = renderLandingIndex(fs.readFileSync(indexTemplate, "utf8"), site);

  fs.rmSync(enabledRoutesDir, { recursive: true, force: true });
  fs.mkdirSync(enabledRoutesDir, { recursive: true });
  const enabledRoutes = [];
  for (const file of fs.readdirSync(routesDir).sort()) {
    const feature = path.basename(file, ".caddy");
    if (!file.endsWith(".caddy") || !isSiteFeature(feature)) {
      throw new Error(`Route snippet ${file} does not name a site feature`);
    }
    if (!site.has(feature)) continue;
    fs.copyFileSync(path.join(routesDir, file), path.join(enabledRoutesDir, file));
    enabledRoutes.push(feature);
  }

  fs.writeFileSync(path.join(landingDir, "index.html"), index);
  fs.writeFileSync(path.join(landingDir, "env-config.js"), renderEnvConfig(env));
  return { site, enabledRoutes };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    const { site, enabledRoutes } = setupSite({
      env: process.env,
      indexTemplate: "/opt/site/landing-index.html",
      landingDir: "/srv/landing",
      routesDir: "/etc/caddy/routes",
      enabledRoutesDir: "/etc/caddy/routes.d",
    });
    // Startup output before Caddy runs; the container log is the only sink.
    console.log(`Site ${site.shortName}: features ${site.features.join(",")}; `
      + `routes ${enabledRoutes.join(",") || "none"}; og image ${site.ogImage || "packaged"}`);
  } catch (error) {
    console.error(`Invalid site configuration: ${error.message || error}`);
    process.exitCode = 1;
  }
}
