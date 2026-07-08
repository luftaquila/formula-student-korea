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
// Opens a streaming fetch and collects parsed SSE events so a test can assert
// what the server pushed and (via the paired POST) answer them.
async function openSse(url, headers, readyEvent, base = baseUrl) {
  const controller = new AbortController();
  const res = await fetch(`${base}${url}`, {
    headers: { ...headers, Accept: 'text/event-stream' },
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
  await handle.waitFor(readyEvent);
  openStreams.push(handle);
  return handle;
}

// A device stream (rover / gps), internal-authed.
const openStream = (device) =>
  openSse(`/api/rover/stream?device=${device}`, internalHeaders, 'connected');

// The browser event stream (/api/events), admin-authed.
const openBrowserEvents = () =>
  openSse('/api/events', { Cookie: adminCookie }, 'init');

async function status() {
  const res = await client.get('/api/rover/status', { cookie: adminCookie });
  assert.equal(res.status, 200);
  return res.json();
}

// Run a test against an ISOLATED server so in-memory receiver/rover state (which
// leaks across the shared server's tests) is deterministic.
async function withFreshServer(fn, appOptions = {}) {
  const p = tmpDbPath();
  const app2 = createCourseApp({ dbPath: p, ...appOptions });
  const started2 = await startServer(app2.app);
  const cli2 = createClient(started2.baseUrl);
  try {
    await fn({ url: started2.baseUrl, cli: cli2, db: app2.db });
  } finally {
    started2.server.closeAllConnections?.();
    await stopServer(started2.server);
    app2.db.close();
    cleanup(p);
  }
}

const statusOf = async (cli) => {
  const res = await cli.get('/api/rover/status', { cookie: adminCookie });
  assert.equal(res.status, 200);
  return res.json();
};

async function poll(fn, pred, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
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

// ─── liveness watchdog (powered-off device stops showing ONLINE) ───────────
// An abrupt power-off leaves the SSE socket half-open, so req.on("close") won't
// fire for minutes. The watchdog must flip the device offline once its telemetry
// (every 3s in prod) goes silent. Here we shrink the thresholds so it trips fast.
describe('device liveness watchdog', () => {
  it('marks the receiver offline when telemetry goes silent while the SSE stays open', async () => {
    await withFreshServer(async ({ url, cli }) => {
      // Keep the SSE stream OPEN the whole time — this is the half-open-socket
      // case where only the watchdog (not req.on close) can notice the silence.
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url);
      try {
        assert.equal((await statusOf(cli)).receiver.connected, true, 'online right after connect');
        const s = await poll(() => statusOf(cli), (x) => x.receiver.connected === false);
        assert.equal(s.receiver.connected, false, 'watchdog flipped it offline');
        assert.equal(s.receiver.last_disconnect_reason, 'stale');
      } finally {
        receiver.close();
      }
    }, { deviceStaleMs: 150, deviceWatchdogTickMs: 30 });
  });

  it('keeps the receiver online while telemetry keeps arriving', async () => {
    await withFreshServer(async ({ url, cli }) => {
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url);
      try {
        // Post telemetry every 80ms (< the 150ms stale window) for longer than
        // one stale window; last_seen keeps refreshing so it must NOT trip.
        for (let i = 0; i < 5; i++) {
          await cli.post('/api/rover/telemetry?device=gps', { headers: internalHeaders, body: { fix_status: 'rtk_fixed' } });
          await new Promise((r) => setTimeout(r, 80));
        }
        assert.equal((await statusOf(cli)).receiver.connected, true, 'telemetry kept it online');
      } finally {
        receiver.close();
      }
    }, { deviceStaleMs: 150, deviceWatchdogTickMs: 30 });
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
    // Give the receiver a fresh fix so it is the active capture source (don't
    // rely on a position leaking in from an earlier test on the shared server).
    await client.post('/api/rover/position?device=gps', {
      headers: internalHeaders, body: { lat: 37.5, lng: 127.0, alt: 10 },
    });

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

  it('returns 422 when the device reports a cone-capture failure', async () => {
    const receiver = await openStream('gps');
    // Give the receiver a position so it is the active capture source.
    await client.post('/api/rover/position?device=gps', {
      headers: internalHeaders, body: { lat: 37.5, lng: 127.0, alt: 10 },
    });
    const reqPromise = client.post('/api/rover/request', { cookie: adminCookie });
    const evt = await receiver.waitFor('request-position');
    // Device couldn't hold a stable RTK fix → explicit failure (no coords).
    await client.post('/api/rover/position?device=gps', {
      headers: internalHeaders,
      body: { request_id: evt.data.request_id, capture_failed: true, error: 'no_stable_rtk_fix' },
    });
    const res = await reqPromise;
    assert.equal(res.status, 422);
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('falls back to the rover when no receiver is connected', async () => {
    // Isolated server: this must not depend on a prior test's receiver SSE close
    // being observed within a fixed sleep (a late close would leave a still-fresh
    // receiver last_position and misroute the request).
    await withFreshServer(async ({ url, cli }) => {
      const rover = await openSse('/api/rover/stream?device=rover', internalHeaders, 'connected', url);
      const reqPromise = cli.post('/api/rover/request', { cookie: adminCookie });
      const evt = await rover.waitFor('request-position');
      await cli.post('/api/rover/position?device=rover', {
        headers: internalHeaders,
        body: { lat: 36.0, lng: 128.0, alt: 5, request_id: evt.data.request_id },
      });
      const res = await reqPromise;
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.lat, 36.0);
      rover.close();
    });
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

// ─── request routing matches the active source ───────────────────────────────
describe('POST /api/rover/request routing vs active source', () => {
  it('falls back to the rover when the receiver is connected but has no fix', async () => {
    // Fresh server so receiverState.last_position is genuinely empty — the shared
    // server's in-memory state leaks a receiver position from earlier tests.
    const dbPath2 = tmpDbPath();
    const app2 = createCourseApp({ dbPath: dbPath2 });
    const started2 = await startServer(app2.app);
    const srv2 = started2.server;
    const url2 = started2.baseUrl;
    const cli2 = createClient(url2);
    try {
      const rover = await openSse('/api/rover/stream?device=rover', internalHeaders, 'connected', url2);
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url2);
      // Rover has a fix; the receiver is connected in capture mode but never posts.
      await cli2.post('/api/rover/position?device=rover', {
        headers: internalHeaders, body: { lat: 36.5, lng: 127.5, alt: 8 },
      });
      const s = await (await cli2.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(s.position_source, 'rover'); // receiver has no last_position

      // The request must route to the ROVER, not the fix-less receiver.
      const reqPromise = cli2.post('/api/rover/request', { cookie: adminCookie });
      const evt = await rover.waitFor('request-position');
      assert.equal(
        receiver.events.some((e) => e.event === 'request-position'), false,
        'a fix-less receiver must not receive the request',
      );
      await cli2.post('/api/rover/position?device=rover', {
        headers: internalHeaders, body: { lat: 36.6, lng: 127.6, alt: 9, request_id: evt.data.request_id },
      });
      const r = await reqPromise;
      assert.equal(r.status, 200);
      assert.equal((await r.json()).lat, 36.6);
      rover.close();
      receiver.close();
    } finally {
      srv2.closeAllConnections?.();
      await stopServer(srv2);
      app2.db.close();
      cleanup(dbPath2);
    }
  });
});

// ─── base receiver reconnect broadcasts base mode immediately ─────────────────
describe('base receiver reconnect', () => {
  it('the connect broadcast already reflects base mode (not capture)', async () => {
    const create = await client.post('/api/gps/survey-points', {
      cookie: adminCookie, body: { name: 'base-reconnect' },
    });
    const point = await create.json();
    await client.post('/api/rover/base/survey-result', {
      headers: internalHeaders,
      body: { point_id: point.id, lat: 37.22, lng: 127.22, alt: 30, h_acc: 0.01, samples: 60 },
    });
    await client.put('/api/gps/config', {
      cookie: adminCookie, body: { ntrip_source: 'base', active_base_point_id: point.id },
    });

    // Browser subscribes BEFORE the receiver connects; the FIRST status with the
    // receiver connected must already show mode "base" (reapply runs before the
    // connect broadcast).
    const browser = await openBrowserEvents();
    const receiver = await openStream('gps');
    const evt = await browser.waitFor('rover:status', { match: (d) => d.receiver && d.receiver.connected });
    assert.equal(evt.data.receiver.mode, 'base');

    await client.put('/api/gps/config', { cookie: adminCookie, body: { ntrip_source: 'ngii' } });
    browser.close();
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── survey failure is surfaced (not silent) ─────────────────────────────────
describe('survey failure reporting', () => {
  it('an ok:false survey result resets surveying + broadcasts a failure event', async () => {
    const create = await client.post('/api/gps/survey-points', {
      cookie: adminCookie, body: { name: 'survey-fail' },
    });
    const point = await create.json();
    const receiver = await openStream('gps');
    // Start a survey → server marks it "surveying".
    const started = await client.post(`/api/gps/survey-points/${point.id}/survey`, {
      cookie: adminCookie, body: { duration_s: 10 },
    });
    assert.equal(started.status, 200);

    const browser = await openBrowserEvents();
    // Device reports failure (not enough stable RTK-fixed samples).
    const res = await client.post('/api/rover/base/survey-result', {
      headers: internalHeaders,
      body: { point_id: point.id, ok: false, error: 'insufficient_samples' },
    });
    assert.equal(res.status, 200);

    const evt = await browser.waitFor('gps:survey_result', { match: (d) => d.point_id === point.id });
    assert.equal(evt.data.ok, false);
    assert.equal(evt.data.error, 'insufficient_samples');

    // Surveying state cleared; the point stays unsurveyed (no coordinate).
    const s = await status();
    assert.equal(s.receiver.base.state, 'idle');
    const pts = await (await client.get('/api/gps/survey-points', { cookie: adminCookie })).json();
    assert.equal(pts.points.find((p) => p.id === point.id).lat, null);

    browser.close();
    receiver.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── base source with no receiver ────────────────────────────────────────────
describe('base source without a connected receiver', () => {
  it('status exposes ntrip_source and the selection is audited via logger.warn', async () => {
    // Fresh server guarantees no receiver is connected.
    const dbPath2 = tmpDbPath();
    const app2 = createCourseApp({ dbPath: dbPath2 });
    const started2 = await startServer(app2.app);
    const srv2 = started2.server;
    const cli2 = createClient(started2.baseUrl);
    try {
      const create = await cli2.post('/api/gps/survey-points', { cookie: adminCookie, body: { name: 'base-no-recv' } });
      const point = await create.json();
      await cli2.post('/api/rover/base/survey-result', {
        headers: internalHeaders,
        body: { point_id: point.id, lat: 37.4, lng: 127.4, alt: 20, h_acc: 0.01, samples: 30 },
      });
      const put = await cli2.put('/api/gps/config', {
        cookie: adminCookie, body: { ntrip_source: 'base', active_base_point_id: point.id },
      });
      assert.equal(put.status, 200); // allowed even with no receiver (operator's choice)

      const s = await (await cli2.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(s.ntrip_source, 'base');

      const warned = app2.db.prepare(
        "SELECT COUNT(*) AS c FROM logs WHERE action='gps.config.update' AND level='warn' AND detail LIKE '%base_selected_no_receiver%'",
      ).get().c;
      assert.ok(warned >= 1, 'base-with-no-receiver is audited via logger.warn');
    } finally {
      srv2.closeAllConnections?.();
      await stopServer(srv2);
      app2.db.close();
      cleanup(dbPath2);
    }
  });
});

// ─── live-marker event carries the correct source ────────────────────────────
describe('live marker event source (device → source mapping)', () => {
  it('a receiver position broadcasts a rover event with source "receiver"', async () => {
    await withFreshServer(async ({ url, cli }) => {
      const browser = await openSse('/api/events', { Cookie: adminCookie }, 'init', url);
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url);
      await cli.post('/api/rover/position?device=gps', {
        headers: internalHeaders, body: { lat: 37.5, lng: 127.0, alt: 30 },
      });
      // The receiver is the active source, so the fast-path marker event must fire
      // and label the coordinate as coming from the receiver (not "gps").
      const evt = await browser.waitFor('rover', { match: (d) => d.source === 'receiver' });
      assert.deepEqual({ lat: evt.data.lat, lng: evt.data.lng }, { lat: 37.5, lng: 127.0 });
      browser.close();
      receiver.close();
    });
  });
});

// ─── a disconnected receiver stops being the capture source ───────────────────
describe('receiver disconnect clears its stale position', () => {
  it('after the receiver drops, capture falls back to the rover (no stale routing)', async () => {
    await withFreshServer(async ({ url, cli }) => {
      const rover = await openSse('/api/rover/stream?device=rover', internalHeaders, 'connected', url);
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url);
      await cli.post('/api/rover/position?device=gps', {
        headers: internalHeaders, body: { lat: 37.5, lng: 127.0, alt: 30 },
      });
      await cli.post('/api/rover/position?device=rover', {
        headers: internalHeaders, body: { lat: 36.5, lng: 127.5, alt: 8 },
      });
      let s = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(s.position_source, 'receiver');

      receiver.close();
      // Wait for the server to observe the SSE close and clear the stale position.
      await new Promise((r) => setTimeout(r, 200));
      s = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(s.receiver.last_position, null, 'stale position dropped on disconnect');
      assert.equal(s.position_source, 'rover', 'capture falls back to the rover');
      rover.close();
    });
  });
});

// ─── survey start rejects a concurrent survey ─────────────────────────────────
describe('survey start conflict', () => {
  it('returns 409 when a survey is already in progress', async () => {
    await withFreshServer(async ({ url, cli }) => {
      const receiver = await openSse('/api/rover/stream?device=gps', internalHeaders, 'connected', url);
      const create = await cli.post('/api/gps/survey-points', { cookie: adminCookie, body: { name: 'busy-pt' } });
      const point = await create.json();
      const first = await cli.post(`/api/gps/survey-points/${point.id}/survey`, {
        cookie: adminCookie, body: { duration_s: 30 },
      });
      assert.equal(first.status, 200);
      const second = await cli.post(`/api/gps/survey-points/${point.id}/survey`, {
        cookie: adminCookie, body: { duration_s: 30 },
      });
      assert.equal(second.status, 409, 'a second survey while one runs is rejected');
      receiver.close();
    });
  });
});

// ─── survey-result rejects a malformed success report ─────────────────────────
describe('survey-result coordinate validation', () => {
  it('rejects (and logs) an ok:true report with invalid coordinates', async () => {
    await withFreshServer(async ({ url, cli, db: db2 }) => {
      const create = await cli.post('/api/gps/survey-points', { cookie: adminCookie, body: { name: 'coord-pt' } });
      const point = await create.json();
      const res = await cli.post('/api/rover/base/survey-result', {
        headers: internalHeaders,
        body: { point_id: point.id, ok: true, lat: 999, lng: 127.0, alt: 30, h_acc: 0.01, samples: 100 },
      });
      assert.equal(res.status, 400);
      const warned = db2.prepare(
        "SELECT COUNT(*) AS c FROM logs WHERE action='gps.survey.result' AND level='warn'",
      ).get().c;
      assert.ok(warned >= 1, 'invalid ok:true report is audited via logger.warn');
    });
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
