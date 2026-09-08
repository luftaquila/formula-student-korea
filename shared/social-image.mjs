import { readFile } from 'node:fs';
import { resolve } from 'node:path';

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Only packaged SPA entry documents use this handler; downloads never pass through it.
export function htmlPage(file, root, { fallthrough = false } = {}) {
  const filename = resolve(root, file);
  return (req, res, next) => {
    readFile(filename, 'utf8', (error, html) => {
      if (error) {
        if (error.code === 'ENOENT') {
          if (fallthrough) return next();
          error.status = 404;
        }
        return next(error);
      }
      const image = escapeAttribute(`https://${req.get('host')}/og-image.png`);
      // The title is already HTML-escaped; retain its entities inside the attribute.
      const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Formula Student Korea')
        .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const tags = [
        ['property', 'og:title', title],
        ['name', 'twitter:title', title],
        ['property', 'og:type', 'website'],
        ['property', 'og:site_name', 'Formula Student Korea'],
        ['property', 'og:image', image],
        ['property', 'og:image:type', 'image/png'],
        ['property', 'og:image:width', '1200'],
        ['property', 'og:image:height', '630'],
        ['property', 'og:image:alt', 'Formula Student Korea — 체크 패턴과 대회명'],
        ['name', 'twitter:card', 'summary_large_image'],
        ['name', 'twitter:image', image],
        ['name', 'twitter:image:alt', 'Formula Student Korea — 체크 패턴과 대회명'],
      ].filter(([attribute, key]) => !new RegExp(`<meta\\b[^>]*\\b${attribute}\\s*=\\s*["']${key}["']`, 'i').test(html))
        .map(([attribute, key, value]) => `<meta ${attribute}="${key}" content="${value}">`).join('\n');
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html.replace(/<\/head\s*>/i, `${tags}\n</head>`));
    });
  };
}

export function htmlEntries(root) {
  const index = htmlPage('index.html', root, { fallthrough: true });
  const publicPage = htmlPage('public.html', root, { fallthrough: true });
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/' || req.path === '/index.html') return index(req, res, next);
    if (req.path === '/public.html') return publicPage(req, res, next);
    next();
  };
}
