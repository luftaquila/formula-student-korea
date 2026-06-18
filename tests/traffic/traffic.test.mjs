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
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createTrafficApp } from '../../traffic/index.mjs';

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createTrafficApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

// ─── Health ─────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

// ─── Records ────────────────────────────────────────────────────────────
describe('GET /api/records (initial)', () => {
  it('returns array with no dynamic record tables initially', async () => {
    const res = await client.get('/api/records', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });
});

describe('GET /api/records/:name (non-existent)', () => {
  it('returns 404 for non-existent table', async () => {
    const res = await client.get(`/api/records/${encodeURIComponent('NoSuchTable')}`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/records', () => {
  it('creates a record (auto-creates table with FSK year prefix)', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '가속 1차',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          entry: { num: 1, univ: '서울대', team: '팀A' },
          result: 50000,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('validates record data (missing fields → 400)', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '가속 2차',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          // missing entry and result
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates entry data (missing num → 400)', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '가속 2차',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          entry: { univ: '서울대', team: '팀A' },
          result: 50000,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates result is integer (400)', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '가속 2차',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          entry: { num: 1, univ: '서울대', team: '팀A' },
          result: 50.5,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid record name (400)', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          entry: { num: 1, univ: '서울대', team: '팀A' },
          result: 50000,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/records (after creation)', () => {
  it('includes the created table', async () => {
    const res = await client.get('/api/records', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    const tableName = `FSK ${new Date().getFullYear()} 가속 1차`;
    assert.ok(data.includes(tableName));
  });
});

describe('GET /api/records/:name (existing)', () => {
  it('returns records from created table', async () => {
    const tableName = `FSK ${new Date().getFullYear()} 가속 1차`;
    const res = await client.get(`/api/records/${encodeURIComponent(tableName)}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].num, 1);
    assert.equal(data[0].univ, '서울대');
    assert.equal(data[0].team, '팀A');
    assert.equal(data[0].type, '가속');
    assert.equal(data[0].result, 50000);
    assert.equal(data[0].invalidated, 0);
    assert.equal(data[0].scoreboard, 1);
  });
});

describe('PATCH /api/records/:name/:rowid', () => {
  const tableName = `FSK ${new Date().getFullYear()} 가속 1차`;

  it('toggles invalidated (invalidated ON → scoreboard auto OFF)', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'invalidated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.invalidated, 1);
    assert.equal(data.scoreboard, 0);
  });

  it('toggles invalidated back (invalidated OFF → scoreboard auto ON)', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'invalidated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.invalidated, 0);
    assert.equal(data.scoreboard, 1);
  });

  it('toggles scoreboard', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'scoreboard' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.scoreboard, 0);
  });

  it('updates detail', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'detail', value: 'test detail' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.detail, 'test detail');
  });

  it('updates cones', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'cones', value: 3 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cones, 3);
  });

  it('updates oc', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'oc', value: 2 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.oc, 2);
  });

  it('rejects invalid field (400)', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      body: { field: 'badfield' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent table', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent('NoSuchTable')}/1`, {
      body: { field: 'invalidated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('returns 404 for non-existent rowid', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/9999`, {
      body: { field: 'invalidated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('clamps negative cones value to 0', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      cookie: adminCookie,
      body: { field: 'cones', value: -5 },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cones, 0, 'negative cones should be clamped to 0');
  });

  it('clamps negative oc value to 0', async () => {
    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/1`, {
      cookie: adminCookie,
      body: { field: 'oc', value: -3 },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.oc, 0, 'negative oc should be clamped to 0');
  });
});

// ─── Record Visibility ─────────────────────────────────────────────────
describe('GET /api/records/visibility', () => {
  it('returns visibility map', async () => {
    const res = await client.get('/api/records/visibility', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data, 'object');
  });
});

describe('PUT /api/records/:name/visibility', () => {
  const tableName = `FSK ${new Date().getFullYear()} 가속 1차`;

  it('toggles visibility off', async () => {
    const res = await client.put(`/api/records/${encodeURIComponent(tableName)}/visibility`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, tableName);
    assert.equal(data.visible, 0);
  });

  it('reflects in visibility map', async () => {
    const res = await client.get('/api/records/visibility', { cookie: adminCookie });
    const data = await res.json();
    assert.equal(data[tableName], false);
  });

  it('toggles visibility back on', async () => {
    const res = await client.put(`/api/records/${encodeURIComponent(tableName)}/visibility`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.visible, 1);
  });

  it('returns 404 for non-existent table', async () => {
    const res = await client.put(`/api/records/${encodeURIComponent('NoSuchTable')}/visibility`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/records/:name', () => {
  it('deletes table', async () => {
    const tableName = `FSK ${new Date().getFullYear()} 가속 1차`;
    const res = await client.delete(`/api/records/${encodeURIComponent(tableName)}`, { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify it's gone
    const listRes = await client.get('/api/records', { cookie: adminCookie });
    const data = await listRes.json();
    assert.ok(!data.includes(tableName));
  });

  it('returns 404 for non-existent table', async () => {
    const res = await client.delete(`/api/records/${encodeURIComponent('NoSuchTable')}`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Controllers ────────────────────────────────────────────────────────
describe('GET /api/controllers (initial)', () => {
  it('returns empty array initially', async () => {
    const res = await client.get('/api/controllers', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });
});

describe('POST /api/controllers', () => {
  it('creates controller log', async () => {
    const res = await client.post('/api/controllers', {
      body: { timestamp: '2026-01-01T10:00:00', data: 'test data' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('validates required fields (missing timestamp → 400)', async () => {
    const res = await client.post('/api/controllers', {
      body: { data: 'test data' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates required fields (missing data → 400)', async () => {
    const res = await client.post('/api/controllers', {
      body: { timestamp: '2026-01-01T10:00:00' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates timestamp is string (400)', async () => {
    const res = await client.post('/api/controllers', {
      body: { timestamp: 12345, data: 'test data' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/controllers (after creation)', () => {
  it('returns created log', async () => {
    const res = await client.get('/api/controllers', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].timestamp, '2026-01-01T10:00:00');
    assert.equal(data[0].data, 'test data');
  });
});

describe('DELETE /api/controllers', () => {
  it('deletes all controller logs', async () => {
    const res = await client.delete('/api/controllers', { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify all gone
    const listRes = await client.get('/api/controllers', { cookie: adminCookie });
    const data = await listRes.json();
    assert.equal(data.length, 0);
  });
});

// ─── Event Modes ────────────────────────────────────────────────────────
describe('GET /api/event-modes', () => {
  it('returns default modes, all enabled', async () => {
    const res = await client.get('/api/event-modes', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 4);
    const types = data.map(d => d.event_type);
    assert.ok(types.includes('가속'));
    assert.ok(types.includes('스키드패드'));
    assert.ok(types.includes('오토크로스'));
    assert.ok(types.includes('짐카나'));
    for (const mode of data) {
      assert.equal(mode.enabled, 1);
    }
  });
});

describe('PUT /api/event-modes/:type', () => {
  it('toggles mode (enabled → disabled)', async () => {
    const res = await client.put(`/api/event-modes/${encodeURIComponent('가속')}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.event_type, '가속');
    assert.equal(data.enabled, 0);
  });

  it('toggles mode back (disabled → enabled)', async () => {
    const res = await client.put(`/api/event-modes/${encodeURIComponent('가속')}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.event_type, '가속');
    assert.equal(data.enabled, 1);
  });

  it('returns 404 for non-existent mode', async () => {
    const res = await client.put(`/api/event-modes/${encodeURIComponent('없는모드')}`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────
describe('Auth enforcement', () => {
  it('POST /api/records without auth returns 401', async () => {
    const res = await client.post('/api/records', {
      body: {
        name: '가속 2차',
        data: {
          time: '2026-01-01T10:00:00',
          type: '가속',
          entry: { num: 1, univ: '서울대', team: '팀A' },
          result: 50000,
        },
      },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/health without auth returns 200 (public)', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
  });
});

// ─── SSE Broadcast Payloads ─────────────────────────────────────────────

function connectSSE(sseBaseUrl, sseUrlPath, cookie) {
  const events = [];
  const controller = new AbortController();
  const ready = new Promise((resolve) => {
    fetch(`${sseBaseUrl}${sseUrlPath}`, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) currentEvent = line.slice(7);
            else if (line.startsWith('data: ') && currentEvent) {
              const parsed = JSON.parse(line.slice(6));
              events.push({ event: currentEvent, data: parsed });
              if (currentEvent === 'init') resolve();
              currentEvent = null;
            }
          }
        }
      } catch {}
    }).catch(() => {});
  });
  return { events, close: () => controller.abort(), ready };
}

describe('SSE broadcast payloads', () => {
  it('POST /api/records broadcasts full row with record field', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;

    const res = await client.post('/api/records', {
      body: {
        name: 'SSE 테스트 1차',
        data: {
          time: '2026-01-01T11:00:00',
          type: '가속',
          entry: { num: 5, univ: 'SSE대학교', team: 'SSE팀' },
          result: 12345,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Give SSE time to propagate
    await new Promise(r => setTimeout(r, 200));
    sse.close();

    const recordEvents = sse.events.filter(e => e.event === 'records');
    assert.ok(recordEvents.length >= 1, 'should receive at least one records event');

    const addEvent = recordEvents.find(e => e.data.type === 'add');
    assert.ok(addEvent, 'should have an "add" type event');
    assert.ok(addEvent.data.record, 'event should have record field');
    assert.equal(addEvent.data.record.num, 5);
    assert.equal(addEvent.data.record.univ, 'SSE대학교');
    assert.equal(addEvent.data.record.team, 'SSE팀');
    assert.equal(addEvent.data.record.type, '가속');
    assert.equal(addEvent.data.record.result, 12345);
    assert.ok(addEvent.data.record.rowid, 'record should have rowid');
    assert.ok(Array.isArray(addEvent.data.recordFiles), 'should include recordFiles');
  });

  it('PATCH /api/records/:name/:rowid broadcasts full updated row', async () => {
    const tableName = `FSK ${new Date().getFullYear()} SSE 테스트 1차`;

    // Get the row's rowid
    const listRes = await client.get(`/api/records/${encodeURIComponent(tableName)}`, { cookie: adminCookie });
    const rows = await listRes.json();
    const rowid = rows[0].rowid;

    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;

    const res = await client.patch(`/api/records/${encodeURIComponent(tableName)}/${rowid}`, {
      body: { field: 'cones', value: 2 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 200));
    sse.close();

    const recordEvents = sse.events.filter(e => e.event === 'records');
    assert.ok(recordEvents.length >= 1, 'should receive at least one records event');

    const updateEvent = recordEvents.find(e => e.data.type === 'update');
    assert.ok(updateEvent, 'should have an "update" type event');
    assert.ok(updateEvent.data.record, 'event should have record field');
    assert.equal(updateEvent.data.record.rowid, rowid);
    assert.equal(updateEvent.data.record.num, 5);
    assert.equal(updateEvent.data.record.cones, 2);
    assert.equal(updateEvent.data.field, 'cones');
    assert.ok(Array.isArray(updateEvent.data.recordFiles), 'should include recordFiles');

    // Cleanup: delete the test table
    await client.delete(`/api/records/${encodeURIComponent(tableName)}`, { cookie: adminCookie });
  });
});

// ─── Wireless: ingest & raw events ──────────────────────────────────────
describe('POST /api/wireless/ingest', () => {
  it('stores raw events and preserves 64-bit master_tick as string', async () => {
    const bigTick = '1844674407370955161'; // > 2^53, must survive as string
    const res = await client.post('/api/wireless/ingest', {
      body: { events: [{ node_id: '1', master_tick: bigTick, ev_seq: 1, rssi: -70.5, snr: 9.25 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.stored, 1);
    assert.equal(data.deduped, 0);

    const listRes = await client.get('/api/wireless/events?since=0', { cookie: adminCookie });
    const rows = await listRes.json();
    const row = rows.find(r => r.node_id === '1' && r.ev_seq === 1);
    assert.ok(row, 'event row should be present');
    assert.equal(row.master_tick, bigTick, 'master_tick string preserved');
    assert.equal(row.rssi, -70.5);
  });

  it('is idempotent on (node_id, ev_seq)', async () => {
    const ev = { node_id: '2', master_tick: '1000', ev_seq: 7 };
    const r1 = await client.post('/api/wireless/ingest', { body: { events: [ev] }, cookie: adminCookie });
    assert.equal((await r1.json()).stored, 1);
    const r2 = await client.post('/api/wireless/ingest', { body: { events: [ev] }, cookie: adminCookie });
    const d2 = await r2.json();
    assert.equal(d2.stored, 0);
    assert.equal(d2.deduped, 1);
  });

  it('rejects malformed body (events not array of valid rows)', async () => {
    const res = await client.post('/api/wireless/ingest', {
      body: { events: [{ node_id: '1', master_tick: 'not-a-number', ev_seq: 1 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('persists at most one throttled telemetry snapshot per node, live state has latest', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'tnode', rssi: -80, snr: 5, offset_us: 100, skew_ppm: 3.0, latency_ms: 20, link_state: 'online' }] },
      cookie: adminCookie,
    });
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'tnode', rssi: -82, snr: 6, offset_us: 120, skew_ppm: 3.1, latency_ms: 22, link_state: 'online' }] },
      cookie: adminCookie,
    });
    const snapCount = db.prepare("SELECT COUNT(*) AS c FROM wireless_telemetry WHERE node_id = 'tnode'").get().c;
    assert.equal(snapCount, 1, 'only one snapshot persisted within throttle window');

    const stateRes = await client.get('/api/wireless/state', { cookie: adminCookie });
    const state = await stateRes.json();
    const live = state.telemetry.find(t => t.node_id === 'tnode');
    assert.ok(live, 'live telemetry present');
    assert.equal(live.rssi, -82, 'live state reflects latest values');
    assert.equal(live.offset_us, 120);
  });

  it('last_seen reflects firmware last_seen_ms (age), not ingest time', async () => {
    // A diag line reporting "lost" carries a large age; "수신"은 ingest 시각이 아니라
    // 마스터가 마지막으로 들은 시각이어야 한다(= now - last_seen_ms).
    const before = Date.now();
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'agednode', rssi: -90, snr: 2, skew_ppm: 0, link_state: 'lost', last_seen_ms: 20000 }] },
      cookie: adminCookie,
    });
    const after = Date.now();

    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const live = state.telemetry.find(t => t.node_id === 'agednode');
    assert.ok(live, 'live telemetry present');
    const age = after - new Date(live.last_seen).getTime();
    // 20s age (±오차) — 절대 "방금"이면 안 됨.
    assert.ok(age >= 20000 - 100 && age <= 20000 + (after - before) + 100,
      `last_seen should be ~20s old, got ${age}ms`);
  });

  it('last_seen falls back to ingest time when last_seen_ms is absent', async () => {
    const before = Date.now();
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'freshnode', rssi: -70, snr: 8, skew_ppm: 1, link_state: 'online' }] },
      cookie: adminCookie,
    });
    const after = Date.now();
    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const live = state.telemetry.find(t => t.node_id === 'freshnode');
    assert.ok(live, 'live telemetry present');
    const seen = new Date(live.last_seen).getTime();
    assert.ok(seen >= before - 100 && seen <= after + 100, 'last_seen ~= ingest time on fallback');
  });

  it('carries temperature and battery through to live state', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'battnode', rssi: -75, snr: 7, skew_ppm: 2, link_state: 'online', temp_c10: 235, batt_mv: 3920 }] },
      cookie: adminCookie,
    });
    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const live = state.telemetry.find(t => t.node_id === 'battnode');
    assert.ok(live, 'live telemetry present');
    assert.equal(live.temp_c10, 235, 'die temp (deci-C) carried through');
    assert.equal(live.batt_mv, 3920, 'battery mV carried through');
  });

  it('accepts the master self-diag row (node 0) with temp + charge-rail mV', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: '0', link_state: 'online', temp_c10: 310, batt_mv: 4280 }] },
      cookie: adminCookie,
    });
    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const master = state.telemetry.find(t => t.node_id === '0');
    assert.ok(master, 'master row present');
    assert.equal(master.temp_c10, 310);
    assert.equal(master.batt_mv, 4280);
  });

  it('leaves temp/batt null when absent', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'notempnode', rssi: -70, link_state: 'online' }] },
      cookie: adminCookie,
    });
    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const live = state.telemetry.find(t => t.node_id === 'notempnode');
    assert.ok(live, 'live telemetry present');
    assert.equal(live.temp_c10, null);
    assert.equal(live.batt_mv, null);
  });
});

// ─── Wireless: mapping CRUD ─────────────────────────────────────────────
describe('Wireless mapping', () => {
  it('GET returns array (initially without our node)', async () => {
    const res = await client.get('/api/wireless/mapping', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
  });

  it('PUT upserts a mapping', async () => {
    const res = await client.put('/api/wireless/mapping/3', {
      body: { event_type: '가속', role: 'start', label: '출발선' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const row = await res.json();
    assert.equal(row.node_id, '3');
    assert.equal(row.event_type, '가속');
    assert.equal(row.role, 'start');

    const list = await (await client.get('/api/wireless/mapping', { cookie: adminCookie })).json();
    assert.ok(list.some(m => m.node_id === '3' && m.role === 'start'));
  });

  it('PUT rejects invalid event_type and invalid role', async () => {
    const r1 = await client.put('/api/wireless/mapping/3', { body: { event_type: '없는종목', role: 'start' }, cookie: adminCookie });
    assert.equal(r1.status, 400);
    const r2 = await client.put('/api/wireless/mapping/3', { body: { event_type: '가속', role: 'middle' }, cookie: adminCookie });
    assert.equal(r2.status, 400);
  });

  it('PUT updates existing node_id (no duplicate row)', async () => {
    await client.put('/api/wireless/mapping/3', { body: { event_type: '오토크로스', role: 'start' }, cookie: adminCookie });
    const list = await (await client.get('/api/wireless/mapping', { cookie: adminCookie })).json();
    const rows3 = list.filter(m => m.node_id === '3');
    assert.equal(rows3.length, 1);
    assert.equal(rows3[0].event_type, '오토크로스');
  });

  it('DELETE removes the mapping', async () => {
    const res = await client.delete('/api/wireless/mapping/3', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const list = await (await client.get('/api/wireless/mapping', { cookie: adminCookie })).json();
    assert.ok(!list.some(m => m.node_id === '3'));
  });
});

// ─── Wireless: physical-light event designation ─────────────────────────
describe('Wireless physical-event designation', () => {
  it('PUT designates the physical-light event', async () => {
    const res = await client.put('/api/wireless/physical-event', { body: { event_type: '가속' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).owner_event, '가속');
  });

  it('PUT can change the designation to another event', async () => {
    const res = await client.put('/api/wireless/physical-event', { body: { event_type: '스키드패드' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).owner_event, '스키드패드');
  });

  it('PUT null clears the designation (all virtual)', async () => {
    const res = await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).owner_event, null);
  });

  it('PUT rejects an invalid event (400)', async () => {
    const res = await client.put('/api/wireless/physical-event', { body: { event_type: '없는종목' }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('light report updates color and green tick for the designated event', async () => {
    await client.put('/api/wireless/physical-event', { body: { event_type: '가속' }, cookie: adminCookie });
    const res = await client.post('/api/wireless/light', { body: { color: 'green', green_tick: '987654321012' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const row = await res.json();
    assert.equal(row.light_color, 'green');
    assert.equal(row.green_tick, '987654321012');
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
  });
});

// ─── Wireless: state & SSE ──────────────────────────────────────────────
describe('Wireless state & SSE', () => {
  it('GET /api/wireless/state returns light/mapping/telemetry/bridge', async () => {
    const res = await client.get('/api/wireless/state', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(s.light && 'owner_event' in s.light);
    assert.ok(Array.isArray(s.mapping));
    assert.ok(Array.isArray(s.telemetry));
    assert.ok(s.bridge && 'online' in s.bridge);
  });

  it('SSE init frame includes the wireless block', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    sse.close();
    const init = sse.events.find(e => e.event === 'init');
    assert.ok(init, 'init event received');
    assert.ok(init.data.wireless, 'init has wireless block');
    assert.ok('light' in init.data.wireless);
    assert.ok(Array.isArray(init.data.wireless.mapping));
    assert.ok(Array.isArray(init.data.wireless.telemetry));
    assert.ok('bridge' in init.data.wireless);
  });

  it('ingest broadcasts wireless:event over SSE', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await client.post('/api/wireless/ingest', {
      body: { events: [{ node_id: '5', master_tick: '5000', ev_seq: 1, rssi: -60, snr: 11 }] },
      cookie: adminCookie,
    });
    await new Promise(r => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find(e => e.event === 'wireless:event');
    assert.ok(ev, 'received wireless:event');
    assert.ok(ev.data.events.some(x => x.node_id === '5'));
  });

  it('physical-event designation broadcasts wireless:light over SSE', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await client.put('/api/wireless/physical-event', { body: { event_type: '짐카나' }, cookie: adminCookie });
    await new Promise(r => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find(e => e.event === 'wireless:light');
    assert.ok(ev, 'received wireless:light');
    assert.equal(ev.data.owner_event, '짐카나');
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
  });

  it('mapping PUT broadcasts wireless:mapping over SSE', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await client.put('/api/wireless/mapping/6', { body: { event_type: '짐카나', role: 'lane1' }, cookie: adminCookie });
    await new Promise(r => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find(e => e.event === 'wireless:mapping');
    assert.ok(ev, 'received wireless:mapping');
    assert.equal(ev.data.node_id, '6');
    await client.delete('/api/wireless/mapping/6', { cookie: adminCookie });
  });
});

// ─── Wireless: auth enforcement ─────────────────────────────────────────
describe('Wireless auth enforcement', () => {
  it('POST /api/wireless/ingest without auth returns 401', async () => {
    const res = await client.post('/api/wireless/ingest', { body: { events: [] } });
    assert.equal(res.status, 401);
  });
  it('PUT /api/wireless/mapping/:node without auth returns 401', async () => {
    const res = await client.put('/api/wireless/mapping/9', { body: { event_type: '가속', role: 'start' } });
    assert.equal(res.status, 401);
  });
  it('PUT /api/wireless/physical-event without auth returns 401', async () => {
    const res = await client.put('/api/wireless/physical-event', { body: { event_type: '가속' } });
    assert.equal(res.status, 401);
  });
  it('GET /api/wireless/state without auth returns 401', async () => {
    const res = await client.get('/api/wireless/state');
    assert.equal(res.status, 401);
  });
});
