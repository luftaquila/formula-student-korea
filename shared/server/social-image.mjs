import { readFile } from 'node:fs';
import { resolve } from 'node:path';
import { socialMetaTags } from '../common/social-meta.js';

// Stands in for the page title, which arrives already escaped from the document.
const TITLE = Symbol('title');

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Only packaged SPA entry documents use this handler; downloads never pass through it.
// Their <title> holds the page name; the deployment's short name is prefixed here so
// titles and Open Graph tags carry it before JavaScript runs.
export function htmlPage(file, root, { fallthrough = false, site } = {}) {
  if (!site) throw new Error("htmlPage requires the site configuration");
  const filename = resolve(root, file);
  const shortName = escapeAttribute(site.shortName);
  const siteName = escapeAttribute(site.name);
  return (req, res, next) => {
    readFile(filename, 'utf8', (error, html) => {
      if (error) {
        if (error.code === 'ENOENT') {
          if (fallthrough) return next();
          error.status = 404;
        }
        return next(error);
      }
      const titleElement = /(<title\b[^>]*>)([\s\S]*?)(<\/title>)/i;
      const pageTitle = html.match(titleElement)?.[2].trim();
      // The page title is already HTML-escaped; retain its entities.
      const fullTitle = pageTitle ? `${shortName} ${pageTitle}` : siteName;
      html = html.replace(titleElement, (_match, open, _text, close) => `${open}${fullTitle}${close}`);
      const title = fullTitle.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const tags = socialMetaTags({ title: TITLE, site, origin: `https://${req.get('host')}` })
        .filter(([attribute, key]) => !new RegExp(`<meta\\b[^>]*\\b${attribute}\\s*=\\s*["']${key}["']`, 'i').test(html))
        .map(([attribute, key, value]) =>
          `<meta ${attribute}="${key}" content="${value === TITLE ? title : escapeAttribute(value)}">`).join('\n');
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html.replace(/<\/head\s*>/i, () => `${tags}\n</head>`));
    });
  };
}

export function htmlEntries(root, site) {
  const index = htmlPage('index.html', root, { fallthrough: true, site });
  const publicPage = htmlPage('public.html', root, { fallthrough: true, site });
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/' || req.path === '/index.html') return index(req, res, next);
    if (req.path === '/public.html') return publicPage(req, res, next);
    next();
  };
}
