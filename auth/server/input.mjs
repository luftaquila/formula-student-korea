// Google profile pictures are the only avatars we render. Accept nothing else so the
// URL that every page embeds in an <img> can only point at Google's image CDN, which
// is also the single host the Caddy img-src allowlist admits.
export function sessionPicture(url) {
  if (typeof url !== "string" || url.length > 512) return "";
  return /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//i.test(url) ? url : "";
}
