import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createCourseApp } from '../../course/index.mjs';

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const internalHeaders = { 'X-Internal-Service': TEST_INTERNAL_SECRET };

let server, baseUrl, client, db, dbPath;
const openStreams = [];

before(async () => {
  dbPath = tmpDbPath();
  const result = createCourseApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  for (const s of openStreams) s.close();
  // SSE sockets are long-lived; force them shut so server.close() can resolve.
  server.closeAllConnections?.();
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

// ─── SSE test client ─────────────────────────────────────────────────────
// Opens a streaming fetch to /api/rover/stream and collects parsed events so a
// test can assert what the server pushed and (via the paired POST) answer them.
async function openStream(device) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/rover/stream?device=${device}`, {
    headers: { ...internalHeaders, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = null;
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch { /* aborted */ }
  })();
  const handle = {
    events,
    close: () => controller.abort(),
    async waitFor(name, { timeoutMs = 10000, match = null } = {}) {
      const start = Date.now();
      for (;;) {
        const e = events.find((x) => x.event === name && !x._seen && (!match || match(x.data)));
        if (e) { e._seen = true; return e; }
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for "${name}"`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  await handle.waitFor('connected');
  openStreams.push(handle);
  return handle;
}

async function status() {
  const res = await client.get('/api/rover/status', { cookie: adminCookie });
  assert.equal(res.status, 200);
  return res.json();
}

// ─── status shape ─────────────────────────────────────────────────────────
describe('GET /api/rover/status', () => {
  it('includes receiver block + position_source', async () => {
    const s = await status();
    assert.ok(Object.prototype.hasOwnProperty.call(s, 'receiver'));
    assert.equal(s.receiver.connected, false);
    assert.equal(s.receiver.mode, 'capture');
    assert.equal(s.position_source, null);
  });
});

// ─── dual connection (no eviction) ─────────────────────────────────────────
describe('dual rover + receiver connection', () => {
  it('both slots stay connected simultaneously', async () => {
    const rover = await openStream('rover');
    const receiver = await openStream('gps');
    // Give the server a tick to register both.
    await new Promise((r) => setTimeout(r, 50));
    const s = await status();
    assert.equal(s.connected, true, 'rover connected');
    assert.equal(s.receiver.connected, true, 'receiver connected');
    rover.close();
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── position source priority ──────────────────────────────────────────────
describe('position_source priority', () => {
  it('prefers the receiver once it is connected and has posted a position', async () => {
    const receiver = await openStream('gps');
    await client.post('/api/rover/position?device=gps', {
      headers: internalHeaders,
      body: { lat: 37.5, lng: 127.0, alt: 30 },
    });
    const s = await status();
    assert.equal(s.position_source, 'receiver');
    assert.deepEqual(
      { lat: s.receiver.last_position.lat, lng: s.receiver.last_position.lng },
      { lat: 37.5, lng: 127.0 },
    );
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── /api/rover/request routes to the receiver first ───────────────────────
describe('POST /api/rover/request routing', () => {
  it('sends request-position to the receiver when it is connected in capture mode', async () => {
    const rover = await openStream('rover');
    const receiver = await openStream('gps');

    const reqPromise = client.post('/api/rover/request', { cookie: adminCookie });
    // The receiver (preferred) must be the one asked, not the rover.
    const evt = await receiver.waitFor('request-position');
    const requestId = evt.data.request_id;
    assert.ok(requestId);
    assert.equal(
      rover.events.some((e) => e.event === 'request-position'),
      false,
      'rover should not receive the request when the receiver is present',
    );

    // Answer as the receiver.
    await client.post('/api/rover/position?device=gps', {
      headers: internalHeaders,
      body: { lat: 37.1, lng: 127.9, alt: 12, request_id: requestId },
    });
    const res = await reqPromise;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual({ lat: body.lat, lng: body.lng }, { lat: 37.1, lng: 127.9 });

    rover.close();
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('falls back to the rover when no receiver is connected', async () => {
    const rover = await openStream('rover');
    const reqPromise = client.post('/api/rover/request', { cookie: adminCookie });
    const evt = await rover.waitFor('request-position');
    await client.post('/api/rover/position?device=rover', {
      headers: internalHeaders,
      body: { lat: 36.0, lng: 128.0, alt: 5, request_id: evt.data.request_id },
    });
    const res = await reqPromise;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lat, 36.0);
    rover.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── GPS config + survey points ────────────────────────────────────────────
describe('GPS management config + survey points', () => {
  it('defaults to NGII source', async () => {
    const res = await client.get('/api/gps/config', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const cfg = await res.json();
    assert.equal(cfg.ntrip_source, 'ngii');
    assert.equal(cfg.active_base_point_id, null);
  });

  it('rejects base source without a surveyed point', async () => {
    const create = await client.post('/api/gps/survey-points', {
      cookie: adminCookie,
      body: { name: 'start-line' },
    });
    assert.equal(create.status, 201);
    const point = await create.json();

    const bad = await client.put('/api/gps/config', {
      cookie: adminCookie,
      body: { ntrip_source: 'base', active_base_point_id: point.id },
    });
    assert.equal(bad.status, 400, 'unsurveyed point cannot be a base');

    // Survey the point via the internal result endpoint, then base should work.
    const result = await client.post('/api/rover/base/survey-result', {
      headers: internalHeaders,
      body: { point_id: point.id, lat: 37.7, lng: 127.7, alt: 40, h_acc: 0.01, samples: 120 },
    });
    assert.equal(result.status, 200);

    const ok = await client.put('/api/gps/config', {
      cookie: adminCookie,
      body: { ntrip_source: 'base', active_base_point_id: point.id },
    });
    assert.equal(ok.status, 200);
    const cfg = await ok.json();
    assert.equal(cfg.ntrip_source, 'base');
    assert.equal(cfg.active_base_point_id, point.id);

    const s = await status();
    assert.equal(s.receiver.mode, 'base');

    // Cannot delete the point while it is the active base.
    const del = await client.delete(`/api/gps/survey-points/${point.id}`, { cookie: adminCookie });
    assert.equal(del.status, 409);

    // Switch back to NGII, then deletion is allowed.
    await client.put('/api/gps/config', { cookie: adminCookie, body: { ntrip_source: 'ngii' } });
    const del2 = await client.delete(`/api/gps/survey-points/${point.id}`, { cookie: adminCookie });
    assert.equal(del2.status, 200);
  });
});

// ─── base activation event wiring ───────────────────────────────────────────
describe('base activation propagates to both devices', () => {
  it('base → receiver base-activate + rover ntrip-source; revert → base-stop + ngii', async () => {
    const create = await client.post('/api/gps/survey-points', {
      cookie: adminCookie, body: { name: 'base-A' },
    });
    const point = await create.json();
    await client.post('/api/rover/base/survey-result', {
      headers: internalHeaders,
      body: { point_id: point.id, lat: 37.31, lng: 127.32, alt: 33, h_acc: 0.008, samples: 100 },
    });

    const rover = await openStream('rover');
    const receiver = await openStream('gps');

    const put = await client.put('/api/gps/config', {
      cookie: adminCookie, body: { ntrip_source: 'base', active_base_point_id: point.id },
    });
    assert.equal(put.status, 200);

    const activate = await receiver.waitFor('base-activate');
    assert.equal(activate.data.lat, 37.31);
    assert.equal(activate.data.point_id, point.id);
    const toBase = await rover.waitFor('ntrip-source', { match: (d) => d.source === 'base' });
    assert.equal(toBase.data.source, 'base');

    await client.put('/api/gps/config', { cookie: adminCookie, body: { ntrip_source: 'ngii' } });
    await receiver.waitFor('base-stop');
    const toNgii = await rover.waitFor('ntrip-source', { match: (d) => d.source === 'ngii' });
    assert.equal(toNgii.data.source, 'ngii');

    rover.close();
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── RTCM relay ────────────────────────────────────────────────────────────
describe('POST /api/rover/base/rtcm relay', () => {
  it('relays RTCM chunks to the connected rover as an rtcm event', async () => {
    const rover = await openStream('rover');
    const payload = Buffer.from('rtcm-bytes').toString('base64');
    const res = await client.post('/api/rover/base/rtcm', {
      headers: internalHeaders,
      body: { data: payload },
    });
    assert.equal(res.status, 200);
    const evt = await rover.waitFor('rtcm');
    assert.equal(evt.data.data, payload);
    rover.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── gating ────────────────────────────────────────────────────────────────
describe('access control', () => {
  it('GPS config requires admin', async () => {
    const res = await client.get('/api/gps/config');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  it('base RTCM requires the internal secret', async () => {
    const res = await client.post('/api/rover/base/rtcm', {
      cookie: adminCookie,
      body: { data: 'AAAA' },
    });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });
});
