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
