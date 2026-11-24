import test from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../../shared/server/express-setup.mjs';
import { addSpaFallback } from '../../shared/server/service-bootstrap.mjs';
import { startServer, stopServer, setupTestEnv, testSite, TRUST_JWT } from '../helpers/test-utils.mjs';
import { DEFAULT_OG_IMAGE_ALT } from '../../shared/common/site-config.js';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');
const requireVue = createRequire(require.resolve('vue/package.json'));
const { parse } = requireVue('@vue/compiler-dom');

function readMetadata(html) {
  const result = [];
  function visit(node) {
    if (node.tag === 'meta') {
      const attrs = Object.fromEntries(node.props.map(attr => [attr.name, attr.value?.content]));
      result.push([attrs.property ?? attrs.name, attrs.content]);
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(parse(html));
  return result;
}
setupTestEnv();

test('application HTML includes same-host social images on direct and nested visits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fsk-social-html-'));
  const html = '<!doctype html><html><head><title>Example page</title><meta property="og:title" content="Custom title"></head><body><main>Page</main></body></html>';
  writeFileSync(join(root, 'index.html'), html);
  writeFileSync(join(root, 'download.html'), html);
  const app = createApp({ express, staticRoot: root, validateUser: TRUST_JWT }, req => req.path === '/private' ? 'admin' : null);
  app.get('/api/example', (req, res) => res.json({ value: '{{not a template}}' }));
  addSpaFallback(app, root);
  const { server, baseUrl } = await startServer(app);
  t.after(async () => { await stopServer(server); rmSync(root, { recursive: true, force: true }); });
  for (const path of ['/', '/index.html', '/nested/page']) {
    const response = await new Promise((resolve, reject) => {
      get(baseUrl + path, { headers: { Host: 'preview.example.org', 'X-Forwarded-Host': 'unrelated.example.org' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const entries = readMetadata(body);
    const metadata = new Map(entries);
    assert.equal(metadata.get('og:image'), 'https://preview.example.org/og-image.png');
    assert.equal(metadata.get('og:title'), 'Custom title');
    // The page title gains the deployment's short name; the site name labels the image.
    assert.equal(metadata.get('twitter:title'), 'TC Example page');
    assert.match(body, /<title>TC Example page<\/title>/);
    assert.equal(metadata.get('og:site_name'), 'Test Competition');
    // The packaged image keeps its own description and known PNG size.
    assert.equal(metadata.get('og:image:alt'), DEFAULT_OG_IMAGE_ALT);
    assert.equal(metadata.get('og:image:width'), '1200');
    assert.equal(entries.filter(([key]) => key === 'og:image').length, 1);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  assert.equal(await (await fetch(baseUrl + '/download.html')).text(), html);
  assert.deepEqual(await (await fetch(baseUrl + '/api/example')).json(), { value: '{{not a template}}' });
  assert.equal((await fetch(baseUrl + '/private', { redirect: 'manual' })).status, 302);
});

test('a configured link-preview image replaces the packaged one and its size tags', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fsk-social-custom-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>Lookup</title></head><body></body></html>');
  const site = testSite({ SITE_OG_IMAGE: 'https://cdn.example.org/preview.png?v=1&size=large' });
  const app = createApp({ express, staticRoot: root, validateUser: TRUST_JWT, site }, () => null);
  addSpaFallback(app, root);
  const { server, baseUrl } = await startServer(app);
  t.after(async () => { await stopServer(server); rmSync(root, { recursive: true, force: true }); });
  const body = await (await fetch(baseUrl + '/')).text();
  const metadata = new Map(readMetadata(body));
  assert.equal(metadata.get('og:image'), 'https://cdn.example.org/preview.png?v=1&size=large');
  assert.equal(metadata.get('twitter:image'), metadata.get('og:image'));
  assert.equal(metadata.get('og:image:alt'), 'Test Competition');
  for (const key of ['og:image:type', 'og:image:width', 'og:image:height']) assert.equal(metadata.has(key), false, key);
  assert.match(body, /content="https:\/\/cdn\.example\.org\/preview\.png\?v=1&amp;size=large"/);
});

test('configured names reach the metadata literally, including replacement patterns', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fsk-social-literal-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>Lookup</title></head><body></body></html>');
  const site = testSite({ SITE_NAME: "Cup $& $' $$ $`" });
  const app = createApp({ express, staticRoot: root, validateUser: TRUST_JWT, site }, () => null);
  addSpaFallback(app, root);
  const { server, baseUrl } = await startServer(app);
  t.after(async () => { await stopServer(server); rmSync(root, { recursive: true, force: true }); });
  const metadata = new Map(readMetadata(await (await fetch(baseUrl + '/')).text()));
  assert.equal(metadata.get('og:site_name'), "Cup $& $' $$ $`");
});
