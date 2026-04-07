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
