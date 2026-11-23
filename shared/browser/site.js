import { browserSiteConfig, parseSiteConfig } from "../common/site-config.js";

// The deployment's site configuration, delivered by env-config.js before the app
// bundle runs. Without it (for example in a Node test) the defaults apply, as they
// do for every variable a deployment leaves unset.
const raw = (typeof window !== "undefined" && window.__SITE__) || browserSiteConfig(parseSiteConfig({}));

export const site = Object.freeze({
  name: typeof raw?.name === "string" ? raw.name : "",
  shortName: typeof raw?.shortName === "string" ? raw.shortName : "",
  features: Object.freeze(Array.isArray(raw?.features) ? [...raw.features] : []),
  links: Object.freeze(Array.isArray(raw?.links) ? raw.links.map((link) => Object.freeze({ ...link })) : []),
});

export function hasFeature(feature) {
  return site.features.includes(feature);
}

// Page titles and headings carry the short name, e.g. "FSK 서류 제출".
export function siteTitle(title) {
  return site.shortName ? `${site.shortName} ${title}` : title;
}
