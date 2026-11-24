// Open Graph and Twitter tags shared by SPA documents (server-rendered) and the
// landing page (rendered when the Caddy container starts). Values are unescaped;
// callers escape them for their output.
//
// The packaged image is served by Caddy at /og-image.png on whatever host the
// request used, so its URL is built from `origin`. Its type and size are known; a
// deployment's SITE_OG_IMAGE carries no such tags because they are not known here.
export function socialMetaTags({ title, site, origin }) {
  const image = site.ogImage || `${origin}/og-image.png`;
  return [
    ["property", "og:title", title],
    ["name", "twitter:title", title],
    ["property", "og:type", "website"],
    ["property", "og:site_name", site.name],
    ["property", "og:image", image],
    ...(site.ogImage ? [] : [
      ["property", "og:image:type", "image/png"],
      ["property", "og:image:width", "1200"],
      ["property", "og:image:height", "630"],
    ]),
    ["property", "og:image:alt", site.ogImageAlt],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:image", image],
    ["name", "twitter:image:alt", site.ogImageAlt],
  ];
}
