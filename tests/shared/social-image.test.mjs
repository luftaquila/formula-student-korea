import test from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../../shared/server/express-setup.mjs';
import { addSpaFallback } from '../../shared/server/service-bootstrap.mjs';
import { startServer, stopServer, setupTestEnv, TRUST_JWT } from '../helpers/test-utils.mjs';

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
    assert.equal(metadata.get('twitter:title'), 'Example page');
    assert.equal(entries.filter(([key]) => key === 'og:image').length, 1);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  assert.equal(await (await fetch(baseUrl + '/download.html')).text(), html);
  assert.deepEqual(await (await fetch(baseUrl + '/api/example')).json(), { value: '{{not a template}}' });
  assert.equal((await fetch(baseUrl + '/private', { redirect: 'manual' })).status, 302);
});
