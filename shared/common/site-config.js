// Deployment identity and enabled features, read from the environment of every
// runtime. A variable left unset or empty takes the default below, which is the
// Formula Student Korea service with every feature. A value that is set but
// invalid rejects startup.
//
//   SITE_NAME        Full name shown on the landing page, Open Graph, and email.
//   SITE_SHORT_NAME  Prefix for page titles, email subjects, SMS, and file names.
//   PUBLIC_URL       Origin used in links sent outside the browser (email).
//   FEATURES         Comma-separated feature names from site-features.js.
//   SITE_LINKS       JSON array of { name, href, icon? } menu links; [] for none.
//   SITE_OG_IMAGE    Absolute http(s) URL of the link-preview image. The packaged
//                    /og-image.png is used when unset.
//
// This file is bundled into browsers and build tooling; it reads only the
// environment object it is given.
import { isEnvEnabled } from "./env-flags.js";
import { isNavIcon } from "./nav-icons.js";
import { SITE_FEATURE_NAMES, isSiteFeature, parseSiteFeatures } from "./site-features.js";
import { SMS_SHORT_NAME_MAX_BYTES, smsByteLength } from "./sms-template.mjs";

export const SITE_DEFAULTS = Object.freeze({
  SITE_NAME: "Formula Student Korea",
  SITE_SHORT_NAME: "FSK",
  PUBLIC_URL: "https://fsk.luftaquila.io",
  FEATURES: SITE_FEATURE_NAMES.join(","),
  SITE_LINKS: JSON.stringify([
    { name: "에너지미터", href: "https://fsk-energymeter.luftaquila.io/", icon: "energy" },
    { name: "공지 알림봇", href: "https://ksae-notice.luftaquila.io", icon: "notice" },
    { name: "자작차 AI 챗봇", href: "https://ksae-qna.luftaquila.io", icon: "pitbot" },
    { name: "대회 규정집", href: "https://luftaquila.github.io/fsk-rules/", icon: "rules" },
    { name: "자작자동차포럼", href: "https://dnf.luftaquila.io", icon: "forum" },
  ]),
});

// Alt text of the packaged /og-image.png, which shows the FSK name and pattern.
export const DEFAULT_OG_IMAGE_ALT = "Formula Student Korea — 체크 패턴과 대회명";

const LINK_KEYS = new Set(["name", "href", "icon"]);

function setting(env, key) {
  const value = String(env[key] ?? "").trim();
  return value || SITE_DEFAULTS[key] || "";
}

function parseOgImage(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SITE_OG_IMAGE must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("SITE_OG_IMAGE must be an absolute http(s) URL");
  }
  return url.href;
}

function parsePublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_URL must be an absolute http(s) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be an absolute http(s) origin");
  }
  return url.origin;
}

function isLinkHref(href) {
  if (/^\/(?!\/)/.test(href)) return true;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function parseSiteLinks(raw) {
  let links;
  try {
    links = JSON.parse(raw);
  } catch {
    throw new Error("SITE_LINKS must be a JSON array");
  }
  if (!Array.isArray(links)) throw new Error("SITE_LINKS must be a JSON array");

  return Object.freeze(links.map((link, index) => {
    const label = `SITE_LINKS[${index}]`;
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw new Error(`${label} must be an object`);
    }
    const unknown = Object.keys(link).filter((key) => !LINK_KEYS.has(key));
    if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
    const name = typeof link.name === "string" ? link.name.trim() : "";
    if (!name) throw new Error(`${label}.name must be a non-empty string`);
    if (typeof link.href !== "string" || !isLinkHref(link.href)) {
      throw new Error(`${label}.href must be an http(s) URL or a root-relative path`);
    }
    if (link.icon !== undefined && !isNavIcon(link.icon)) {
      throw new Error(`${label}.icon must be a known navigation icon`);
    }
    return Object.freeze({ name, href: link.href, icon: link.icon ?? null });
  }));
}

function createHas(features) {
  const enabled = new Set(features);
  return (feature) => {
    if (!isSiteFeature(feature)) throw new Error(`Unknown feature: ${feature}`);
    return enabled.has(feature);
  };
}

export function parseSiteConfig(env) {
  const features = parseSiteFeatures(setting(env, "FEATURES"));
  const name = setting(env, "SITE_NAME");
  const shortName = setting(env, "SITE_SHORT_NAME");
  // Queue and Registration text participants; their SMS must stay within 90 bytes.
  if ((features.includes("queue") || features.includes("registration"))
    && smsByteLength(shortName) > SMS_SHORT_NAME_MAX_BYTES) {
    throw new Error(`SITE_SHORT_NAME must fit in ${SMS_SHORT_NAME_MAX_BYTES} SMS bytes `
      + "(ASCII 1, Korean 2) when queue or registration is enabled");
  }
  const ogImage = parseOgImage(setting(env, "SITE_OG_IMAGE"));
  return Object.freeze({
    name,
    shortName,
    publicUrl: parsePublicUrl(setting(env, "PUBLIC_URL")),
    features,
    links: parseSiteLinks(setting(env, "SITE_LINKS")),
    // null means the packaged /og-image.png on the requesting host.
    ogImage,
    // A replaced image is described by the site name; the packaged one by its content.
    ogImageAlt: ogImage ? name : DEFAULT_OG_IMAGE_ALT,
    has: createHas(features),
  });
}

// The subset delivered to browsers. The public URL stays server-side because
// browsers already know their origin.
export function browserSiteConfig(site) {
  return {
    name: site.name,
    shortName: site.shortName,
    features: [...site.features],
    links: site.links.map((link) => ({ ...link })),
  };
}

// Content of each SPA's env-config.js, written when a container starts.
export function renderEnvConfig(env) {
  const site = parseSiteConfig(env);
  return [
    `window.__TEST_SERVER__ = ${JSON.stringify(isEnvEnabled(env.TEST_SERVER))};`,
    `window.__SITE__ = ${JSON.stringify(browserSiteConfig(site))};`,
    "",
  ].join("\n");
}
