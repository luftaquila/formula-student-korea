import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSSESubscriber } from '../../shared/sse-client.mjs';

// 간단한 SSE 서버: 연결마다 handler(res)를 호출해 프레임을 직접 밀어넣는다.
function startSseServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}/events` }));
  });
}

function sseHeaders(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
}

function waitFor(checkFn, timeoutMs = 3000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (checkFn()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')); }
    }, intervalMs);
  });
}

describe('createSSESubscriber', () => {
  let server, subscriber;

  afterEach(async () => {
    if (subscriber) subscriber.stop();
    if (server) await new Promise((r) => server.close(r));
    server = subscriber = null;
  });

  it('parses events and delivers JSON payloads to onEvent', async () => {
    const started = await startSseServer((req, res) => {
      sseHeaders(res);
      res.write('event: hello\ndata: {"a":1}\n\n');
      res.write('event: hello\ndata: {"a":2}\n\n');
    });
    server = started.server;

    const events = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      onEvent: (name, data) => events.push([name, data]),
    });
    subscriber.start();
    await waitFor(() => events.length === 2);
    assert.deepEqual(events, [['hello', { a: 1 }], ['hello', { a: 2 }]]);
  });

  it('filters events outside the allowedEvents whitelist', async () => {
    const started = await startSseServer((req, res) => {
      sseHeaders(res);
      res.write('event: noise\ndata: {"x":1}\n\n');
      res.write('event: keep\ndata: {"x":2}\n\n');
    });
    server = started.server;

    const events = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url, allowedEvents: new Set(['keep']),
      onEvent: (name, data) => events.push([name, data]),
    });
    subscriber.start();
    await waitFor(() => events.length === 1);
    assert.deepEqual(events, [['keep', { x: 2 }]]);
  });

  it('sends the provided headers (function form re-evaluated per connect)', async () => {
    let seenHeader = null;
    const started = await startSseServer((req, res) => {
      seenHeader = req.headers['x-internal-service'];
      sseHeaders(res);
    });
    server = started.server;

    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      headers: () => ({ 'X-Internal-Service': 'sekrit' }),
      onEvent: () => {},
    });
    subscriber.start();
    await waitFor(() => seenHeader !== null);
    assert.equal(seenHeader, 'sekrit');
  });

  it('reports parse errors without killing the stream', async () => {
    const started = await startSseServer((req, res) => {
      sseHeaders(res);
      res.write('event: bad\ndata: {not json\n\n');
      res.write('event: good\ndata: {"ok":true}\n\n');
    });
    server = started.server;

    const events = [];
    const warns = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      onEvent: (name, data) => events.push([name, data]),
      onWarn: (kind, detail) => warns.push([kind, detail]),
    });
    subscriber.start();
    await waitFor(() => events.length === 1 && warns.length === 1);
    assert.equal(warns[0][0], 'parse_error');
    assert.equal(warns[0][1].source, 'T');
    assert.deepEqual(events[0], ['good', { ok: true }]);
  });

  it('clears the buffer and warns on overflow', async () => {
    const started = await startSseServer((req, res) => {
      sseHeaders(res);
      // 프레임 종결자 없는 데이터로 버퍼만 채운다
      res.write(`event: big\ndata: ${'x'.repeat(64)}`);
    });
    server = started.server;

    const warns = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url, maxBufferBytes: 32,
      onEvent: () => {},
      onWarn: (kind) => warns.push(kind),
    });
    subscriber.start();
    await waitFor(() => warns.includes('overflow'));
  });

  it('reconnects with a fresh connection after the stream ends and signals onReconnect', async () => {
    let connections = 0;
    const started = await startSseServer((req, res) => {
      connections++;
      sseHeaders(res);
      if (connections === 1) {
        res.write('event: e\ndata: {"n":1}\n\n');
        res.end(); // 스트림 종료 → 재연결 유도
      } else {
        res.write('event: e\ndata: {"n":2}\n\n');
      }
    });
    server = started.server;

    const events = [];
    const warns = [];
    let reconnected = false;
    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      initialBackoffMs: 30, maxBackoffMs: 100,
      onEvent: (name, data) => events.push(data.n),
      onReconnect: () => { reconnected = true; },
      onWarn: (kind) => warns.push(kind),
    });
    subscriber.start();
    await waitFor(() => events.includes(1) && events.includes(2), 5000);
    assert.equal(connections >= 2, true);
    assert.ok(warns.includes('disconnect'));
    assert.equal(reconnected, true, 'second successful connect must fire onReconnect');
  });

  it('warns (not connects) on a non-200 response and keeps backing off', async () => {
    let connections = 0;
    const started = await startSseServer((req, res) => {
      connections++;
      res.writeHead(403);
      res.end('no');
    });
    server = started.server;

    const warns = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      initialBackoffMs: 20, maxBackoffMs: 50,
      onEvent: () => {},
      onWarn: (kind, detail) => warns.push([kind, detail.status]),
    });
    subscriber.start();
    await waitFor(() => warns.length >= 2, 5000);
    assert.ok(warns.every(([kind, status]) => kind === 'subscribe_failed' && status === 403));
  });

  // 회귀: 'end' 없이 소켓이 끊기는 비정상 단절(서버 크래시·TCP 리셋)도 재연결해야 한다.
  // 예전에는 res 'end'만 재연결을 예약해 socket.destroy() 후 구독이 조용히 죽은 채 남았다.
  it('reconnects after an abrupt socket destroy (no end event)', async () => {
    let connections = 0;
    const started = await startSseServer((req, res) => {
      connections++;
      sseHeaders(res);
      if (connections === 1) {
        res.write('event: e\ndata: {"n":1}\n\n');
        // 정상 종료 대신 소켓을 즉시 파괴 — 'end' 없이 'error'/'close'만 발생
        setTimeout(() => res.socket.destroy(), 20);
      } else {
        res.write('event: e\ndata: {"n":2}\n\n');
      }
    });
    server = started.server;

    const events = [];
    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      initialBackoffMs: 30, maxBackoffMs: 100,
      onEvent: (name, data) => events.push(data.n),
    });
    subscriber.start();
    await waitFor(() => events.includes(1) && events.includes(2), 5000);
    assert.ok(connections >= 2, 'must reconnect after the socket reset');
  });

  it('stop() prevents further reconnects', async () => {
    let connections = 0;
    const started = await startSseServer((req, res) => {
      connections++;
      sseHeaders(res);
      res.end();
    });
    server = started.server;

    subscriber = createSSESubscriber({
      name: 'T', url: started.url,
      initialBackoffMs: 20, maxBackoffMs: 50,
      onEvent: () => {},
    });
    subscriber.start();
    await waitFor(() => connections >= 1);
    subscriber.stop();
    const snapshot = connections;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(connections, snapshot, 'no new connections after stop()');
  });
});
