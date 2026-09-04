import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { waitForCondition } from '../helpers/test-utils.mjs';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');

import { createSSEManager } from '../../shared/sse.mjs';

function getSSE(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.sseData = '';
      res.on('data', (chunk) => { res.sseData += chunk.toString(); });
      resolve(res);
    }).on('error', reject);
  });
}

async function readSSEData(res, count) {
  await waitForCondition(
    () => res.sseData.split('\n\n').filter((event) => event.trim()).length >= count,
    { label: `${count} SSE events` },
  );
  return res.sseData;
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

    await readSSEData(res, 1);

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

    await readSSEData(res1, 1);

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
    await readSSEData(res1, 1);
    const closed = once(res1, 'close');
    res1.destroy();
    await closed;

    // Now a new client should be able to connect
    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 200);

    res2.destroy();
  });

  it('event name sanitization removes \\r\\n', async () => {
    const { baseUrl, broadcast } = await createSSEApp();
    const res = await getSSE(`${baseUrl}/events`);

    await readSSEData(res, 1);

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

    await readSSEData(res, 1);

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

// ─── 운영자 가시성: 용량 거부·init 실패 warn 로깅 ─────────────────────────
// createSSEManager(max, { logger })는 sse.rejected / sse.init_failed를 warn으로
// 남기되, 같은 action:reason은 60초에 1회만 기록한다(DoS·깨진 initDataFn 폭주 방어).
describe('SSE Manager logging', () => {
  const servers = [];

  after(async () => {
    for (const s of servers) {
      await new Promise((resolve) => s.close(resolve));
    }
  });

  function makeLogger() {
    const warns = [];
    return {
      warns,
      warn: (req, action, detail) => warns.push({ action, detail }),
    };
  }

  function createLoggedSSEApp({ maxClients = 10, logger, initDataFn = () => ({}), handlerOpts } = {}) {
    const app = express();
    const { broadcast, handler } = createSSEManager(maxClients, { logger });
    app.get('/events', handler(initDataFn, handlerOpts));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        servers.push(server);
        const port = server.address().port;
        resolve({ server, port, broadcast, baseUrl: `http://localhost:${port}` });
      });
    });
  }

  it('max_clients rejection logs one throttled sse.rejected warn', async () => {
    const logger = makeLogger();
    const { baseUrl } = await createLoggedSSEApp({ maxClients: 1, logger });

    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);

    // 첫 거부는 warn을 남긴다.
    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 503);

    // 60초 창 안의 두 번째 거부는 스로틀되어 추가 warn이 없어야 한다.
    const res3 = await getSSE(`${baseUrl}/events`);
    assert.equal(res3.statusCode, 503);

    const rejected = logger.warns.filter((w) => w.action === 'sse.rejected');
    assert.equal(rejected.length, 1, 'second rejection within 60s must be throttled');
    assert.equal(rejected[0].detail.reason, 'max_clients');

    res1.destroy();
    res2.destroy();
    res3.destroy();
  });

  it('max_per_ip rejection logs sse.rejected with reason max_per_ip', async () => {
    const logger = makeLogger();
    const { baseUrl } = await createLoggedSSEApp({
      maxClients: 10,
      logger,
      handlerOpts: { maxPerIp: 1 },
    });

    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);

    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 429);

    const rejected = logger.warns.filter((w) => w.action === 'sse.rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].detail.reason, 'max_per_ip');

    res1.destroy();
    res2.destroy();
  });

  it('throwing initDataFn logs sse.init_failed once and still serves an empty init', async () => {
    const logger = makeLogger();
    const { baseUrl } = await createLoggedSSEApp({
      logger,
      initDataFn: () => { throw new Error('snapshot query failed'); },
    });

    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);
    const data = await readSSEData(res1, 1);
    assert.ok(data.includes('event: init'));
    assert.ok(data.includes('data: {}'), 'broken initDataFn degrades to an empty snapshot');

    // 60초 창 안의 두 번째 실패도 스로틀 대상이다.
    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 200);
    await readSSEData(res2, 1);

    const failed = logger.warns.filter((w) => w.action === 'sse.init_failed');
    assert.equal(failed.length, 1, 'repeated init failures within 60s must be throttled');
    assert.equal(failed[0].detail.reason, 'init_data');
    assert.equal(failed[0].detail.error, 'snapshot query failed');

    res1.destroy();
    res2.destroy();
  });

  it('without a logger, rejection paths do not crash', async () => {
    const { baseUrl } = await createLoggedSSEApp({ maxClients: 1, logger: null });

    const res1 = await getSSE(`${baseUrl}/events`);
    assert.equal(res1.statusCode, 200);

    const res2 = await getSSE(`${baseUrl}/events`);
    assert.equal(res2.statusCode, 503);

    res1.destroy();
    res2.destroy();
  });
});
