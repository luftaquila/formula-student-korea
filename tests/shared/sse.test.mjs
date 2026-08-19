import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');

import { createSSEManager } from '../../shared/sse.mjs';

function getSSE(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      resolve(res);
    }).on('error', reject);
  });
}

function readSSEData(res, count) {
  return new Promise((resolve) => {
    let data = '';
    let received = 0;
    res.on('data', (chunk) => {
      data += chunk.toString();
      // Count complete events (terminated by double newline)
      const events = data.split('\n\n').filter(e => e.trim());
      received = events.length;
      if (received >= count) {
        resolve(data);
      }
    });
    // Timeout fallback
    setTimeout(() => resolve(data), 2000);
  });
}

describe('SSE Manager', () => {
  const servers = [];

  after(async () => {
    for (const s of servers) {
      if (s.listening) await new Promise((resolve) => s.close(resolve));
    }
  });

  function createSSEApp(maxClients = 10) {
    const app = express();
    const { broadcast, handler, close } = createSSEManager(maxClients);
    app.get('/events', handler(() => ({ test: true })));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        servers.push(server);
        const port = server.address().port;
        resolve({ server, port, broadcast, handler, close, baseUrl: `http://localhost:${port}` });
      });
    });
  }

  it('handler returns SSE headers and init event', async () => {
    const { baseUrl } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['connection'], 'keep-alive');

    const data = await readSSEData(res, 1);
    assert.ok(data.includes('event: init'));
    assert.ok(data.includes('"test":true'));

    res.destroy();
  });

  it('broadcast sends events to connected clients', async () => {
    const { baseUrl, broadcast } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);

    // Wait a tick for the client to be registered
    await new Promise((r) => setTimeout(r, 50));

    broadcast('update', { value: 42 });

    const data = await readSSEData(res, 2); // init + update
    assert.ok(data.includes('event: update'));
    assert.ok(data.includes('"value":42'));

    res.destroy();
  });

  it('returns 503 when max clients reached', async () => {
    const { baseUrl } = await createSSEApp(1);

    // Connect first client (fills the slot)
    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);

    // Wait for registration
    await new Promise((r) => setTimeout(r, 50));

    // Second client should get 503
    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 503);

    res1.destroy();
    res2.destroy();
  });

  it('connection close removes client from set', async () => {
    const { baseUrl, broadcast } = await createSSEApp(1);

    // Connect and disconnect
    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);
    res1.destroy();

    // Wait for close event to propagate
    await new Promise((r) => setTimeout(r, 100));

    // Now a new client should be able to connect
    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 200);

    res2.destroy();
  });

  it('event name sanitization removes \\r\\n', async () => {
    const { baseUrl, broadcast } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);

    await new Promise((r) => setTimeout(r, 50));

    broadcast('bad\r\nevent', { ok: true });

    const data = await readSSEData(res, 2);
    // The event name should have \r\n stripped
    assert.ok(data.includes('event: badevent'));
    assert.ok(!data.includes('event: bad\r\nevent'));

    res.destroy();
  });

  it('multiple broadcasts work correctly', async () => {
    const { baseUrl, broadcast } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);

    await new Promise((r) => setTimeout(r, 50));

    broadcast('msg', { n: 1 });
    broadcast('msg', { n: 2 });
    broadcast('msg', { n: 3 });

    const data = await readSSEData(res, 4); // init + 3 messages
    assert.ok(data.includes('"n":1'));
    assert.ok(data.includes('"n":2'));
    assert.ok(data.includes('"n":3'));

    res.destroy();
  });

  it('close drains active streams so the HTTP server can stop promptly', async () => {
    const { server, baseUrl, close } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);
    assert.equal(res.statusCode, 200);
    res.resume();
    const ended = new Promise((resolve) => res.once('end', resolve));

    close();
    await ended;

    const afterClose = await getSSE(`${baseUrl}/events`);
    assert.equal(afterClose.statusCode, 503);
    afterClose.resume();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server.close timed out with an SSE client')), 500);
      server.close((error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    });
  });
});
