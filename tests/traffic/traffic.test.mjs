import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TRUST_JWT,
  TEST_SECRET,
} from '../helpers/test-utils.mjs';
import { currentCompetitionYear } from '../../shared/competition-year.mjs';

setupTestEnv();

import { createTrafficApp } from '../../traffic/index.mjs';

const requireFromTraffic = createRequire(import.meta.resolve('../../traffic/index.mjs'));
const Database = requireFromTraffic('better-sqlite3');
const CURRENT_YEAR = currentCompetitionYear();

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createTrafficApp({ dbPath, validateUser: TRUST_JWT });
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

describe('GET /api/records/year/:year', () => {
  it('returns visible records for the requested competition year', async () => {
    const year = currentCompetitionYear();
    const response = await client.get(`/api/records/year/${year}`, { cookie: adminCookie });
    assert.equal(response.status, 200);
    const tables = await response.json();
    assert.ok(tables.some((table) => table.name === `FSK ${year} 가속 1차`));
  });
});

describe('Wireless security observation (sec_drop baseline)', () => {
  const node = 'sectest-node';
  const secLogs = () =>
    db.prepare("SELECT detail FROM logs WHERE action = 'wireless.security' AND target = ?").all(`node ${node}`);

  async function ingestSecDrop(sec_drop) {
    const res = await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: node, sec_drop }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  }

  it('does not warn on first observation of a non-zero counter (no baseline yet)', async () => {
    // 첫 관측 = TTL prune 후 재등장과 동일(prev 비어 있음). 없는 0 기준과 비교해
    // 거짓 증가 경고를 내면 안 된다.
    await ingestSecDrop(5);
    assert.equal(secLogs().length, 0, 'first sight of sec_drop=5 must not emit a security warning');
  });

  it('does not warn when the counter is unchanged after re-appearing', async () => {
    await ingestSecDrop(5);
    assert.equal(secLogs().length, 0, 'unchanged counter must not warn');
  });

  it('warns only on a genuine increase over the established baseline', async () => {
    await ingestSecDrop(8);
    const logs = secLogs();
    assert.equal(logs.length, 1, 'a real increase must emit exactly one warning');
    assert.equal(JSON.parse(logs[0].detail).delta, 3, 'delta must be measured from the real baseline (8-5)');
  });
});

describe('GET /api/records (after creation)', () => {
  it('includes the created table', async () => {
    const res = await client.get('/api/records', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    const tableName = `FSK ${CURRENT_YEAR} 가속 1차`;
    assert.ok(data.includes(tableName));
  });
});

describe('GET /api/records/:name (existing)', () => {
  it('returns records from created table', async () => {
    const tableName = `FSK ${CURRENT_YEAR} 가속 1차`;
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
  const tableName = `FSK ${CURRENT_YEAR} 가속 1차`;

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
    const res = await client.patch(`/api/records/${encodeURIComponent(`FSK ${CURRENT_YEAR} NoSuchTable`)}/1`, {
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
  const tableName = `FSK ${CURRENT_YEAR} 가속 1차`;

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
    const tableName = `FSK ${CURRENT_YEAR} 가속 1차`;
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
    const audit = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'controller.upload' ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.actor_email, 'admin@test.com');
    assert.deepEqual(JSON.parse(audit.detail), {
      rowid: 1,
      timestamp: '2026-01-01T10:00:00.000Z',
      bytes: 9,
    });
  });

  it('validates required fields (missing timestamp → 400)', async () => {
    const res = await client.post('/api/controllers', {
      body: { data: 'test data' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
    const audit = db.prepare(`
      SELECT level, actor_email, target, detail FROM logs
      WHERE action = 'controller.upload' ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.level, 'warn');
    assert.equal(audit.actor_email, 'admin@test.com');
    assert.equal(audit.target, 'controller');
    assert.deepEqual(JSON.parse(audit.detail), {
      error: '타임스탬프가 누락되었습니다.',
      reason: '타임스탬프가 누락되었습니다.',
      operation: 'upload',
      timestamp: null,
      data_type: 'string',
    });
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
    assert.equal(data[0].timestamp, '2026-01-01T10:00:00.000Z');
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
    assert.ok(types.includes('내구'));
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
    const tableName = `FSK ${CURRENT_YEAR} SSE 테스트 1차`;

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

// ─── Wireless: ingest events ────────────────────────────────────────────
describe('POST /api/wireless/ingest', () => {
  it('stores events and preserves 64-bit master_tick as string', async () => {
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
    assert.equal(Object.hasOwn(row, 'raw'), false);
    const audit = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.ingest' AND level = 'info'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.actor_email, 'admin@test.com');
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.counts, { events: 1, telemetry: 0, stored: 1, deduped: 0, rejected: 0 });
    assert.deepEqual(detail.source_nodes, ['1']);
    assert.ok(detail.event_id_range.first <= detail.event_id_range.last);
  });

  it('is idempotent on (node_id, ev_seq, master_tick) — retransmits dedupe', async () => {
    // 재전송은 같은 node_id·ev_seq·ev_master_t로 다시 도착하므로 한 번만 저장된다.
    const ev = { node_id: '2', master_tick: '1000', ev_seq: 7 };
    const r1 = await client.post('/api/wireless/ingest', { body: { events: [ev] }, cookie: adminCookie });
    assert.equal((await r1.json()).stored, 1);
    const r2 = await client.post('/api/wireless/ingest', { body: { events: [ev] }, cookie: adminCookie });
    const d2 = await r2.json();
    assert.equal(d2.stored, 0);
    assert.equal(d2.deduped, 1);
  });

  it('a reused ev_seq with a new master_tick is NOT deduped (node reboot / seq wrap)', async () => {
    // 노드 재부팅/16-bit seq wrap으로 ev_seq가 재사용돼도 master_tick이 다르면 별개 이벤트.
    // (node_id, ev_seq)만으로 dedupe하면 진짜 이벤트가 옛 행과 충돌해 조용히 사라진다.
    const a = { node_id: 'reboot', master_tick: '5000', ev_seq: 3 };
    const b = { node_id: 'reboot', master_tick: '9000', ev_seq: 3 }; // 같은 seq, 새 tick
    assert.equal((await (await client.post('/api/wireless/ingest', { body: { events: [a] }, cookie: adminCookie })).json()).stored, 1);
    const d = await (await client.post('/api/wireless/ingest', { body: { events: [b] }, cookie: adminCookie })).json();
    assert.equal(d.stored, 1, 'new master_tick → stored, not deduped');
    assert.equal(d.deduped, 0);
  });

  it('skips a malformed item but stores the good ones in the same batch (no batch-wide loss)', async () => {
    // 시리얼 라인 깨짐 등으로 한 항목이 불량이어도 같은 flush의 정상 이벤트는 저장돼야 한다.
    const res = await client.post('/api/wireless/ingest', {
      body: { events: [
        { node_id: 'mix', master_tick: '111', ev_seq: 1 },           // good
        { node_id: 'mix', master_tick: 'not-a-number', ev_seq: 2 },  // bad master_tick → skip
        { node_id: 'mix', master_tick: '222', ev_seq: 3 },           // good
      ] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200, 'request succeeds (per-item skip, not batch reject)');
    const d = await res.json();
    assert.equal(d.stored, 2, 'both good events stored');
    assert.equal(d.rejected, 1, 'one bad item rejected');

    const rows = await (await client.get('/api/wireless/events?since=0', { cookie: adminCookie })).json();
    assert.ok(rows.some(r => r.node_id === 'mix' && r.ev_seq === 1));
    assert.ok(rows.some(r => r.node_id === 'mix' && r.ev_seq === 3));
    assert.ok(!rows.some(r => r.node_id === 'mix' && r.ev_seq === 2), 'bad item not stored');
  });

  it('rejects an oversized batch (>200) as a malformed request', async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({ node_id: 'big', master_tick: String(i + 1), ev_seq: i }));
    const res = await client.post('/api/wireless/ingest', { body: { events }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('exposes a monotonic lastEventId for client reconnect backfill', async () => {
    const before = (await (await client.get('/api/wireless/state', { cookie: adminCookie })).json()).lastEventId;
    assert.equal(typeof before, 'number');
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: 'lid', master_tick: '1', ev_seq: 1 }] }, cookie: adminCookie });
    const after = (await (await client.get('/api/wireless/state', { cookie: adminCookie })).json()).lastEventId;
    assert.ok(after > before, 'lastEventId advances after a new event');
  });

  it('backfill endpoint returns events with id > since in ascending order', async () => {
    // 재연결 클라이언트가 누락분을 받는 경로. since 이후만, id 오름차순.
    const since = (await (await client.get('/api/wireless/state', { cookie: adminCookie })).json()).lastEventId;
    await client.post('/api/wireless/ingest', { body: { events: [
      { node_id: 'bf', master_tick: '10', ev_seq: 1 },
      { node_id: 'bf', master_tick: '20', ev_seq: 2 },
    ] }, cookie: adminCookie });
    const rows = await (await client.get(`/api/wireless/events?since=${since}`, { cookie: adminCookie })).json();
    assert.ok(rows.length >= 2, 'missed events returned');
    assert.ok(rows.every(r => r.id > since), 'only events after since');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].id > rows[i - 1].id, 'ascending id');
  });

  it('keeps latest telemetry in live state without persisted snapshots', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'tnode', rssi: -80, snr: 5, offset_us: 100, skew_ppm: 3.0, latency_ms: 20, link_state: 'online' }] },
      cookie: adminCookie,
    });
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: 'tnode', rssi: -82, snr: 6, offset_us: 120, skew_ppm: 3.1, latency_ms: 22, link_state: 'online' }] },
      cookie: adminCookie,
    });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wireless_telemetry'").get();
    assert.equal(table, undefined, 'wireless_telemetry table is removed');

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

  it('POST /bridge/offline clears bridge.online immediately', async () => {
    await client.post('/api/wireless/ingest', {
      body: { telemetry: [{ node_id: '1', link_state: 'online' }] },
      cookie: adminCookie,
    });
    let s = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(s.bridge.online, true, 'bridge online after ingest');

    const res = await client.post('/api/wireless/bridge/offline', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).online, false);

    s = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(s.bridge.online, false, 'bridge offline without waiting for the 15s watchdog');
  });

  it('keeps bridge memory and persistence aligned across failed online and offline transitions', async () => {
    await client.post('/api/wireless/bridge/offline', { cookie: adminCookie });
    db.exec(`CREATE TRIGGER reject_bridge_online
      BEFORE UPDATE OF bridge_online ON wireless_light
      WHEN NEW.bridge_online = 1
      BEGIN SELECT RAISE(ABORT, 'injected bridge online failure'); END`);
    try {
      const failedOnline = await client.post('/api/wireless/ingest', {
        body: { events: [{ node_id: 'bridge-recovery', master_tick: '1', ev_seq: 1 }] },
        cookie: adminCookie,
      });
      assert.equal(failedOnline.status, 500);
      let state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
      assert.equal(state.bridge.online, false);
      assert.equal(state.light.bridge_online, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wireless_event WHERE node_id = 'bridge-recovery'").get().count, 0);
    } finally {
      db.exec('DROP TRIGGER reject_bridge_online');
    }

    const recovered = await client.post('/api/wireless/ingest', {
      body: { events: [{ node_id: 'bridge-recovery', master_tick: '1', ev_seq: 1 }] },
      cookie: adminCookie,
    });
    assert.equal(recovered.status, 200);
    let state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(state.bridge.online, true);
    assert.equal(state.light.bridge_online, 1);

    db.exec(`CREATE TRIGGER reject_bridge_offline
      BEFORE UPDATE OF bridge_online ON wireless_light
      WHEN NEW.bridge_online = 0
      BEGIN SELECT RAISE(ABORT, 'injected bridge offline failure'); END`);
    try {
      const failedOffline = await client.post('/api/wireless/bridge/offline', { cookie: adminCookie });
      assert.equal(failedOffline.status, 500);
      assert.equal(await failedOffline.text(), '브리지 상태를 저장할 수 없습니다.');
      state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
      assert.equal(state.bridge.online, true);
      assert.equal(state.light.bridge_online, 1);
    } finally {
      db.exec('DROP TRIGGER reject_bridge_offline');
    }

    const offline = await client.post('/api/wireless/bridge/offline', { cookie: adminCookie });
    assert.equal(offline.status, 200);
    state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(state.bridge.online, false);
    assert.equal(state.light.bridge_online, 0);

    const warnings = db.prepare(`
      SELECT action, detail FROM logs
      WHERE level = 'warn' AND action IN ('wireless.ingest', 'wireless.bridge')
        AND detail LIKE '%injected bridge%'
      ORDER BY id
    `).all();
    assert.deepEqual(warnings.map((row) => row.action), ['wireless.ingest', 'wireless.bridge']);
    assert.match(JSON.parse(warnings[0].detail).error, /injected bridge online failure/);
    assert.equal(JSON.parse(warnings[0].detail).phase, 'database_mutation');
    assert.match(JSON.parse(warnings[1].detail).error, /injected bridge offline failure/);
    assert.equal(JSON.parse(warnings[1].detail).phase, 'bridge_transition');
  });
});

// ─── Wireless: debounce setting ─────────────────────────────────────────
describe("Wireless debounce setting", () => {
  it("defaults to 300ms in state", async () => {
    const s = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(s.light.debounce_ms, 300);
  });

  it("PUT updates the window and reflects in state (shared via light row)", async () => {
    const res = await client.put('/api/wireless/debounce', { body: { ms: 250 }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).debounce_ms, 250);
    const s = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    assert.equal(s.light.debounce_ms, 250);
    // restore default
    await client.put('/api/wireless/debounce', { body: { ms: 300 }, cookie: adminCookie });
  });

  it("accepts 0 (debounce off)", async () => {
    const res = await client.put('/api/wireless/debounce', { body: { ms: 0 }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).debounce_ms, 0);
    await client.put('/api/wireless/debounce', { body: { ms: 300 }, cookie: adminCookie });
  });

  it("rejects out-of-range or non-integer values", async () => {
    assert.equal((await client.put('/api/wireless/debounce', { body: { ms: -1 }, cookie: adminCookie })).status, 400);
    assert.equal((await client.put('/api/wireless/debounce', { body: { ms: 99999 }, cookie: adminCookie })).status, 400);
    assert.equal((await client.put('/api/wireless/debounce', { body: { ms: 1.5 }, cookie: adminCookie })).status, 400);
    assert.equal((await client.put('/api/wireless/debounce', { body: {}, cookie: adminCookie })).status, 400);
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
    await client.put('/api/wireless/physical-event', { body: { event_type: '오토크로스' }, cookie: adminCookie });
    await new Promise(r => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find(e => e.event === 'wireless:light');
    assert.ok(ev, 'received wireless:light');
    assert.equal(ev.data.owner_event, '오토크로스');
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
  });

  it('mapping PUT broadcasts wireless:mapping over SSE', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await client.put('/api/wireless/mapping/6', { body: { event_type: '오토크로스', role: 'finish' }, cookie: adminCookie });
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

// ─── Wireless: 경기별 세션 + arm + lease (Phase 2) ────────────────────────
describe('Wireless sessions & arm', () => {
  it('state includes a per-event session row for each event', async () => {
    const res = await client.get('/api/wireless/state', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(Array.isArray(s.sessions));
    assert.equal(s.sessions.length, 4);
    const types = s.sessions.map((x) => x.event_type).sort();
    assert.deepEqual(types, ['가속', '스키드패드', '오토크로스', '내구'].sort());
    // 각 세션은 arm/초기화 대기 상태(불리언)와 light_color를 노출한다.
    for (const sess of s.sessions) {
      assert.equal(typeof sess.armed, 'boolean');
      assert.equal(typeof sess.reset_pending, 'boolean');
      assert.ok(typeof sess.light_color === 'string');
    }
  });

  it('POST /api/wireless/arm green arms the event with light_color green', async () => {
    const res = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'green', green_tick: '16000000' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const sess = await res.json();
    assert.equal(sess.event_type, '가속');
    assert.equal(sess.armed, true);
    assert.equal(sess.light_color, 'green');
    assert.equal(sess.green_tick, '16000000');
  });

  it('POST /api/wireless/arm off disarms the event', async () => {
    const res = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'off' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const sess = await res.json();
    assert.equal(sess.armed, false);
    assert.equal(sess.light_color, 'off');
  });

  it('POST /api/wireless/arm reset authoritatively clears the run identity', async () => {
    const armed = await (await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'green', green_tick: '17000000' }, cookie: adminCookie })).json();
    assert.ok(armed.run_id);
    const res = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'reset' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const sess = await res.json();
    assert.equal(sess.armed, false);
    assert.equal(sess.light_color, 'off');
    assert.equal(sess.run_id, null);
    assert.equal(sess.saved_record_name, null);
    assert.equal(sess.saved_record_rowid, null);
  });

  it('POST /api/wireless/select shares team/event_name on the session', async () => {
    const res = await client.post('/api/wireless/select', {
      body: { event_type: '가속', team: { num: 7, univ: 'KAIST', team: 'EV' }, event_name: 'E2E-Select' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const sess = await res.json();
    assert.equal(sess.event_type, '가속');
    assert.equal(sess.event_name, 'E2E-Select');
    assert.ok(sess.team && sess.team.num === 7 && sess.team.univ === 'KAIST');
    const audit = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.select' AND target = '가속'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.actor_email, 'admin@test.com');
    const detail = JSON.parse(audit.detail);
    assert.equal(detail.after.team.num, 7);
    assert.equal(detail.after.event_name, 'E2E-Select');
  });

  it('POST /api/wireless/arm rejects invalid event/action (400)', async () => {
    const r1 = await client.post('/api/wireless/arm', { body: { event_type: '짐카나', action: 'green' }, cookie: adminCookie });
    assert.equal(r1.status, 400);
    const r2 = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'blink' }, cookie: adminCookie });
    assert.equal(r2.status, 400);
  });

  it('arm broadcasts wireless:session over SSE', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await client.post('/api/wireless/arm', { body: { event_type: '스키드패드', action: 'green', green_tick: '16000000' }, cookie: adminCookie });
    await new Promise((r) => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find((e) => e.event === 'wireless:session');
    assert.ok(ev, 'received wireless:session');
    assert.equal(ev.data.event_type, '스키드패드');
    assert.equal(ev.data.armed, true);
    await client.post('/api/wireless/arm', { body: { event_type: '스키드패드', action: 'off' }, cookie: adminCookie });
  });

  it('SSE init frame includes wireless.sessions', async () => {
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    await new Promise((r) => setTimeout(r, 150));
    sse.close();
    const init = sse.events.find((e) => e.event === 'init');
    assert.ok(init);
    assert.ok(Array.isArray(init.data.wireless.sessions));
  });
});

describe('Wireless lease (per-event exclusive control)', () => {
  const otherCookie = makeAuthCookie({ email: 'other@test.com', name: 'Other', role: 'admin' });

  it('claim sets controller; another user is blocked (409); release clears', async () => {
    const claim = await client.post('/api/wireless/lease/오토크로스', { cookie: adminCookie });
    assert.equal(claim.status, 200);
    const sess = await claim.json();
    assert.equal(sess.controller, 'admin@test.com');

    // 다른 사용자는 arm·lease 모두 차단(409).
    const otherArm = await client.post('/api/wireless/arm', { body: { event_type: '오토크로스', action: 'green', green_tick: '16000000' }, cookie: otherCookie });
    assert.equal(otherArm.status, 409);
    const otherLease = await client.post('/api/wireless/lease/오토크로스', { cookie: otherCookie });
    assert.equal(otherLease.status, 409);

    const rejectedAudits = db.prepare(`
      SELECT action, actor_email, detail FROM logs
      WHERE level = 'warn' AND target = '오토크로스'
        AND action IN ('wireless.arm', 'wireless.lease')
      ORDER BY id DESC LIMIT 2
    `).all().reverse();
    assert.deepEqual(rejectedAudits.map((row) => row.action), ['wireless.arm', 'wireless.lease']);
    assert.ok(rejectedAudits.every((row) => row.actor_email === 'other@test.com'));
    assert.deepEqual(rejectedAudits.map((row) => JSON.parse(row.detail).operation), ['green', 'claim']);
    assert.ok(rejectedAudits.every((row) => JSON.parse(row.detail).reason.includes('다른 사용자가 제어 중')));

    // 보유자는 arm 가능.
    const ownArm = await client.post('/api/wireless/arm', { body: { event_type: '오토크로스', action: 'green', green_tick: '16000000' }, cookie: adminCookie });
    assert.equal(ownArm.status, 200);

    // 해제 후 controller 비워짐.
    const rel = await client.delete('/api/wireless/lease/오토크로스', { cookie: adminCookie });
    assert.equal(rel.status, 200);
    const relSess = await rel.json();
    assert.equal(relSess.controller, null);
    const audits = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.lease' AND target = '오토크로스' AND level = 'info'
      ORDER BY id DESC LIMIT 2
    `).all().reverse();
    assert.deepEqual(audits.map((row) => JSON.parse(row.detail).operation), ['claim', 'release']);
    assert.ok(audits.every((row) => row.actor_email === 'admin@test.com'));
    await client.post('/api/wireless/arm', { body: { event_type: '오토크로스', action: 'off' }, cookie: adminCookie });
  });

  it('logs a controlled database failure while claiming a lease', async () => {
    db.exec(`CREATE TRIGGER reject_lease_claim
      BEFORE UPDATE ON wireless_session
      WHEN OLD.event_type = '내구' AND NEW.controller IS NOT OLD.controller
      BEGIN SELECT RAISE(ABORT, 'injected lease failure'); END`);
    try {
      const res = await client.post('/api/wireless/lease/내구', { cookie: adminCookie });
      assert.equal(res.status, 500);
      const audit = db.prepare(`
        SELECT actor_email, detail FROM logs
        WHERE action = 'wireless.lease' AND level = 'warn' AND target = '내구'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(audit.actor_email, 'admin@test.com');
      assert.equal(JSON.parse(audit.detail).operation, 'claim');
      assert.match(JSON.parse(audit.detail).error, /injected lease failure/);
    } finally {
      db.exec('DROP TRIGGER reject_lease_claim');
    }
  });

  it('lease/arm without auth returns 401', async () => {
    const a = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'green' } });
    assert.equal(a.status, 401);
    const l = await client.post('/api/wireless/lease/가속');
    assert.equal(l.status, 401);
  });
});

describe('Wireless lease (per-session identity)', () => {
  // 같은 계정(이메일)이라도 브라우저 탭(X-Session-Id)별로 controller가 구분돼야 한 탭의
  // claim/takeover가 다른 탭에 잘못 반영되지 않는다.
  const ET = '스키드패드';
  const sid1 = { 'X-Session-Id': 'tab-1' };
  const sid2 = { 'X-Session-Id': 'tab-2' };

  it('distinguishes same-account sessions; control gated to holder; takeover transfers', async () => {
    // 탭1 claim → controller = email#tab-1
    const c1 = await client.post(`/api/wireless/lease/${encodeURIComponent(ET)}`, { cookie: adminCookie, headers: sid1 });
    assert.equal(c1.status, 200);
    assert.equal((await c1.json()).controller, 'admin@test.com#tab-1');

    // 탭2(같은 계정 다른 세션) claim은 409 — 다른 세션 점유 중, 명시적 가로채기 필요.
    const c2 = await client.post(`/api/wireless/lease/${encodeURIComponent(ET)}`, { cookie: adminCookie, headers: sid2 });
    assert.equal(c2.status, 409);

    // 제어는 점유 세션만: 탭2 arm 409, 탭1 arm 200. 409 메시지는 #sid를 가려 email만 노출.
    const arm2 = await client.post('/api/wireless/arm', { body: { event_type: ET, action: 'green', green_tick: '16000000' }, cookie: adminCookie, headers: sid2 });
    assert.equal(arm2.status, 409);
    const msg = await arm2.text();
    assert.ok(msg.includes('admin@test.com') && !msg.includes('#tab-1'), 'controller label hides session id');
    const arm1 = await client.post('/api/wireless/arm', { body: { event_type: ET, action: 'green', green_tick: '16000000' }, cookie: adminCookie, headers: sid1 });
    assert.equal(arm1.status, 200);

    // 가로채기: 같은 계정은 자기 다른 세션 lease를 회수(DELETE) 후 claim 가능.
    const del2 = await client.delete(`/api/wireless/lease/${encodeURIComponent(ET)}`, { cookie: adminCookie, headers: sid2 });
    assert.equal(del2.status, 200);
    const c2b = await client.post(`/api/wireless/lease/${encodeURIComponent(ET)}`, { cookie: adminCookie, headers: sid2 });
    assert.equal(c2b.status, 200);
    assert.equal((await c2b.json()).controller, 'admin@test.com#tab-2');

    // 가로채기당한 탭1은 더 이상 제어 못 함(409).
    const arm1b = await client.post('/api/wireless/arm', { body: { event_type: ET, action: 'green', green_tick: '16000000' }, cookie: adminCookie, headers: sid1 });
    assert.equal(arm1b.status, 409);

    await client.delete(`/api/wireless/lease/${encodeURIComponent(ET)}`, { cookie: adminCookie, headers: sid2 });
    await client.post('/api/wireless/arm', { body: { event_type: ET, action: 'off' }, cookie: adminCookie, headers: sid2 });
  });
});

// ─── 공유 클럭: /api/time (Phase 3c) ──────────────────────────────────────
describe('GET /api/time (shared clock)', () => {
  it('returns server epoch ms without auth', async () => {
    const res = await client.get('/api/time');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.now, 'number');
    assert.ok(data.now > 1_700_000_000_000);
  });
});

// ─── 서버 권위 기록 엔진 (Phase 4b) ────────────────────────────────────────
describe('Wireless server-authoritative record engine', () => {
  const YEAR = CURRENT_YEAR;
  const tbl = (name) => `FSK ${YEAR} ${name}`;

  it('computes and saves a start→finish record from ingested events', async () => {
    const ev = '오토크로스';
    const NS = 'eng-ax-s', NF = 'eng-ax-f', NAME = 'ENG-AX';
    await client.put(`/api/wireless/mapping/${NS}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.put(`/api/wireless/mapping/${NF}`, { body: { event_type: ev, role: 'finish' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 5, univ: 'SNU', team: 'RT' }, event_name: NAME }, cookie: adminCookie });
    const armResponse = await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    const armedSession = await armResponse.json();
    assert.match(armedSession.run_id, /^[0-9a-f-]{36}$/i, 'new run has a stable id');
    assert.equal(armedSession.saved_record_name, null);
    assert.equal(armedSession.saved_record_rowid, null);
    // 출발 100000ms, 도착 100010ms → 결과 10ms
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NS, master_tick: '1600000000', ev_seq: 1 }] }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NF, master_tick: '1600160000', ev_seq: 1 }] }, cookie: adminCookie });

    const res = await client.get(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const rows = await res.json();
    const saved = rows.find((r) => r.type === ev && r.result === 10 && r.num === 5 && r.team === 'RT');
    assert.ok(saved, 'saved record present');

    const state = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const savedSession = state.sessions.find((session) => session.event_type === ev);
    assert.equal(savedSession.run_id, armedSession.run_id, 'record remains bound to the armed run');
    assert.equal(savedSession.saved_record_name, tbl(NAME));
    assert.equal(savedSession.saved_record_rowid, saved.rowid, 'session exposes the exact saved row for reconnect recovery');

    await client.delete(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NS}`, { cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NF}`, { cookie: adminCookie });
  });

  it('computes skidpad lap2 + lap4 sum', async () => {
    const ev = '스키드패드';
    const N = 'eng-sk', NAME = 'ENG-SK';
    await client.put(`/api/wireless/mapping/${N}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 8, univ: 'KU', team: 'SK' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    // 5회 통과(1000ms 간격, 마지막 2000ms): lap2=1000, lap4=2000 → 합 3000
    const ticks = ['1600000000', '1616000000', '1632000000', '1648000000', '1680000000'];
    for (let i = 0; i < ticks.length; i++) {
      await client.post('/api/wireless/ingest', { body: { events: [{ node_id: N, master_tick: ticks[i], ev_seq: i + 1 }] }, cookie: adminCookie });
    }
    const res = await client.get(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(rows.some((r) => r.type === ev && r.result === 3000 && r.num === 8), 'skidpad lap2+lap4 saved');

    await client.delete(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${N}`, { cookie: adminCookie });
  });

  it('appends endurance laps into a single record (result=total, detail=lap list)', async () => {
    const ev = '내구';
    const N = 'eng-en', NAME = 'ENG-EN';
    await client.put(`/api/wireless/mapping/${N}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 12, univ: 'HU', team: 'EN' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    // 4회 통과: 첫 통과=출발선, 이후 랩 1000/2000/1500ms → 총합 4500, detail 3개
    const ticks = ['1600000000', '1616000000', '1648000000', '1672000000'];
    for (let i = 0; i < ticks.length; i++) {
      await client.post('/api/wireless/ingest', { body: { events: [{ node_id: N, master_tick: ticks[i], ev_seq: i + 1 }] }, cookie: adminCookie });
    }
    const rows = await (await client.get(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie })).json();
    const mine = rows.filter((r) => r.type === ev && r.num === 12);
    assert.equal(mine.length, 1, '랩이 한 기록에 이어붙는다(행 1개)');
    assert.equal(mine[0].result, 4500, '총합 시간');
    assert.equal(mine[0].detail, '00:01.000 / 00:02.000 / 00:01.500', '랩 목록 detail');
    const audits = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.record' AND level = 'info' AND target = ?
      ORDER BY id
    `).all(tbl(NAME));
    assert.equal(audits.length, 3, 'first lap insert and every later lap update are audited');
    assert.ok(audits.every((row) => row.actor_email === 'system'));
    const lastAudit = JSON.parse(audits.at(-1).detail);
    assert.equal(lastAudit.run_id?.length > 0, true);
    assert.equal(lastAudit.team_num, 12);
    assert.equal(lastAudit.lap_count, 3);
    assert.equal(lastAudit.lap_detail, '00:01.000 / 00:02.000 / 00:01.500');
    assert.deepEqual(lastAudit.before, {
      result: 3000,
      detail: '00:01.000 / 00:02.000',
    });
    assert.deepEqual(lastAudit.after, {
      result: 4500,
      detail: '00:01.000 / 00:02.000 / 00:01.500',
    });

    await client.delete(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${N}`, { cookie: adminCookie });
  });

  it('saves a DNF (result -1) via /api/wireless/dnf with session attribution', async () => {
    const ev = '오토크로스', NAME = 'ENG-DNF';
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 3, univ: 'A', team: 'B' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    const res = await client.post('/api/wireless/dnf', { body: { event_type: ev }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const rows = await (await client.get(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie })).json();
    assert.ok(rows.some((r) => r.type === ev && r.result === -1 && r.num === 3), 'DNF record saved');
    const dnfAudit = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.dnf' AND target = ? ORDER BY id DESC LIMIT 1
    `).get(ev);
    assert.equal(dnfAudit.actor_email, 'admin@test.com');
    assert.equal(JSON.parse(dnfAudit.detail).team.num, 3);
    const recordAudit = db.prepare(`
      SELECT actor_email FROM logs
      WHERE action = 'wireless.record' AND target = ? ORDER BY id DESC LIMIT 1
    `).get(tbl(NAME));
    assert.equal(recordAudit.actor_email, 'admin@test.com');
    await client.delete(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
  });

  it('DNF without a selection returns 400', async () => {
    const ev = '오토크로스';
    await client.post('/api/wireless/select', { body: { event_type: ev, team: null, event_name: null }, cookie: adminCookie });
    const res = await client.post('/api/wireless/dnf', { body: { event_type: ev }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('does NOT save when the event is not armed (dormant)', async () => {
    const ev = '오토크로스';
    const NS = 'eng-na-s', NF = 'eng-na-f', NAME = 'ENG-NOARM';
    await client.put(`/api/wireless/mapping/${NS}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.put(`/api/wireless/mapping/${NF}`, { body: { event_type: ev, role: 'finish' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 9, univ: 'X', team: 'Y' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie }); // 미무장
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NS, master_tick: '1700000000', ev_seq: 9 }] }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NF, master_tick: '1700160000', ev_seq: 9 }] }, cookie: adminCookie });

    const list = await (await client.get('/api/records', { cookie: adminCookie })).json();
    assert.ok(!list.includes(tbl(NAME)), '미무장 시 기록 테이블 미생성');

    await client.delete(`/api/wireless/mapping/${NS}`, { cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NF}`, { cookie: adminCookie });
  });

  it('physical light green arms+records; duplicate green does NOT reset the run', async () => {
    const ev = '가속';
    const NS = 'dup-s', NF = 'dup-f', NAME = 'ENG-DUPGREEN';
    await client.put(`/api/wireless/mapping/${NS}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.put(`/api/wireless/mapping/${NF}`, { body: { event_type: ev, role: 'finish' }, cookie: adminCookie });
    await client.put('/api/wireless/physical-event', { body: { event_type: ev }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 11, univ: 'A', team: 'B' }, event_name: NAME }, cookie: adminCookie });
    // 물리 신호등 green → 세션 arm + 엔진 런 리셋
    await client.post('/api/wireless/light', { body: { color: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NS, master_tick: '1600000000', ev_seq: 1 }] }, cookie: adminCookie }); // 출발
    // 동일 green 중복 보고 → 런이 리셋되면 안 됨(출발 tick 보존되어야 도착 기록됨)
    await client.post('/api/wireless/light', { body: { color: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NF, master_tick: '1600160000', ev_seq: 1 }] }, cookie: adminCookie }); // 도착
    const rows = await (await client.get(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie })).json();
    assert.ok(rows.some((r) => r.type === ev && r.result === 10 && r.num === 11), '중복 green에도 기록 저장(런 보존)');
    await client.delete(`/api/records/${encodeURIComponent(tbl(NAME))}`, { cookie: adminCookie });
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NS}`, { cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NF}`, { cookie: adminCookie });
  });

  it('skidpad does NOT save when a lap is negative (reordered)', async () => {
    const ev = '스키드패드';
    const N = 'sk-neg', NAME = 'ENG-SK-NEG';
    await client.put(`/api/wireless/mapping/${N}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 12, univ: 'A', team: 'B' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    // 5회 통과인데 5번째(lap4)가 4번째보다 앞선 tick → lap4 음수 → 저장 안 함
    const ticks = ['1600000000', '1616000000', '1632000000', '1648000000', '1640000000']; // 100000,101000,102000,103000,102500ms
    for (let i = 0; i < ticks.length; i++) {
      await client.post('/api/wireless/ingest', { body: { events: [{ node_id: N, master_tick: ticks[i], ev_seq: i + 1 }] }, cookie: adminCookie });
    }
    const list = await (await client.get('/api/records', { cookie: adminCookie })).json();
    assert.ok(!list.includes(tbl(NAME)), '음수 lap이면 저장하지 않음');
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${N}`, { cookie: adminCookie });
  });
});

// ─── 물리 신호등 다운링크 (Phase 5 / 네트워크 제어) ────────────────────────
describe('Wireless physical command downlink', () => {
  it('rejects command for a non-physical event (409)', async () => {
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
    const res = await client.post('/api/wireless/command', { body: { event_type: '가속', action: 'green' }, cookie: adminCookie });
    assert.equal(res.status, 409);
  });

  it('rejects an invalid action (400)', async () => {
    const res = await client.post('/api/wireless/command', { body: { event_type: '가속', action: 'nope' }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('broadcasts wireless:command for the physical event when bridge online', async () => {
    // ingest로 브리지 online 표시
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: 'cmd-x', master_tick: '100', ev_seq: 1 }] }, cookie: adminCookie });
    await client.put('/api/wireless/physical-event', { body: { event_type: '가속' }, cookie: adminCookie });
    const sse = connectSSE(baseUrl, '/api/events', adminCookie);
    await sse.ready;
    const res = await client.post('/api/wireless/command', { body: { event_type: '가속', action: 'green' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    sse.close();
    const ev = sse.events.find((e) => e.event === 'wireless:command');
    assert.ok(ev, 'received wireless:command');
    assert.equal(ev.data.action, 'green');
    assert.equal(ev.data.event_type, '가속');

    // 물리 초기화는 명령 수락만으로 런을 지우지 않고, 마스터의 OFF 보고에서 확정한다.
    await client.post('/api/wireless/light', { body: { color: 'green', green_tick: '17000000' }, cookie: adminCookie });
    const armedState = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const armedSession = armedState.sessions.find((session) => session.event_type === '가속');
    assert.ok(armedSession.run_id);
    await client.post('/api/wireless/light', { body: { color: 'red' }, cookie: adminCookie });
    const reset = await client.post('/api/wireless/command', { body: { event_type: '가속', action: 'reset' }, cookie: adminCookie });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.session.reset_pending, true);
    assert.ok(resetBody.session.run_id, 'physical reset keeps the run until OFF is confirmed');
    const resetAudit = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE action = 'wireless.command' AND target = '가속' AND level = 'info'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(resetAudit.actor_email, 'admin@test.com');
    assert.deepEqual(JSON.parse(resetAudit.detail), {
      action: 'reset',
      before: { reset_pending: false },
      after: { reset_pending: true },
    });
    const beforeOff = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const pendingSession = beforeOff.sessions.find((session) => session.event_type === '가속');
    assert.equal(pendingSession.reset_pending, true);
    assert.ok(pendingSession.run_id, 'reset remains pending until physical OFF');

    // OFF 확인 전에는 어떤 green 경로도 새 런을 열거나 pending을 해제할 수 없다.
    const commandGreen = await client.post('/api/wireless/command', {
      body: { event_type: '가속', action: 'green' }, cookie: adminCookie,
    });
    assert.equal(commandGreen.status, 409);
    assert.match(await commandGreen.text(), /OFF 확인/);
    const armGreen = await client.post('/api/wireless/arm', {
      body: { event_type: '가속', action: 'green', green_tick: '18000000' }, cookie: adminCookie,
    });
    assert.equal(armGreen.status, 409);
    assert.match(await armGreen.text(), /OFF 확인/);
    const reportedGreen = await client.post('/api/wireless/light', {
      body: { color: 'green', green_tick: '18000000' }, cookie: adminCookie,
    });
    assert.equal(reportedGreen.status, 200);
    const afterBlockedGreen = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const stillPending = afterBlockedGreen.sessions.find((session) => session.event_type === '가속');
    assert.equal(stillPending.reset_pending, true);
    assert.equal(stillPending.run_id, armedSession.run_id);
    assert.equal(stillPending.light_color, 'red');

    await client.post('/api/wireless/light', { body: { color: 'off' }, cookie: adminCookie });
    const afterOff = await (await client.get('/api/wireless/state', { cookie: adminCookie })).json();
    const resetSession = afterOff.sessions.find((session) => session.event_type === '가속');
    assert.equal(resetSession.reset_pending, false);
    assert.equal(resetSession.run_id, null);
    await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
  });

  it('audits a reset database failure without publishing the command', async () => {
    await client.post('/api/wireless/ingest', {
      body: { events: [{ node_id: 'cmd-failure', master_tick: '101', ev_seq: 1 }] },
      cookie: adminCookie,
    });
    await client.put('/api/wireless/physical-event', { body: { event_type: '내구' }, cookie: adminCookie });
    db.exec(`CREATE TRIGGER reject_wireless_reset
      BEFORE UPDATE ON wireless_session
      WHEN OLD.event_type = '내구' AND NEW.reset_pending = 1
      BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`);
    try {
      const reset = await client.post('/api/wireless/command', {
        body: { event_type: '내구', action: 'reset' },
        cookie: adminCookie,
      });
      assert.equal(reset.status, 500);
      const audit = db.prepare(`
        SELECT actor_email, detail FROM logs
        WHERE action = 'wireless.command' AND target = '내구' AND level = 'warn'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(audit.actor_email, 'admin@test.com');
      assert.match(JSON.parse(audit.detail).error, /injected reset failure/);
      assert.equal(JSON.parse(audit.detail).action, 'reset');
    } finally {
      db.exec('DROP TRIGGER reject_wireless_reset');
      await client.put('/api/wireless/physical-event', { body: { event_type: null }, cookie: adminCookie });
    }
  });

  it('command without auth returns 401', async () => {
    const res = await client.post('/api/wireless/command', { body: { event_type: '가속', action: 'green' } });
    assert.equal(res.status, 401);
  });
});

// ─── 버그 수정 가드 (검증/음수/DNF) ────────────────────────────────────────
describe('Wireless save guards', () => {
  const YEAR = CURRENT_YEAR;

  it('select rejects a malformed team (400)', async () => {
    const r1 = await client.post('/api/wireless/select', { body: { event_type: '가속', team: { num: '5', univ: 'X', team: 'Y' } }, cookie: adminCookie });
    assert.equal(r1.status, 400); // num이 문자열
    const r2 = await client.post('/api/wireless/select', { body: { event_type: '가속', team: { num: 0, univ: 'X', team: 'Y' } }, cookie: adminCookie });
    assert.equal(r2.status, 400); // num < 1
    const r3 = await client.post('/api/wireless/select', { body: { event_type: '가속', team: { num: 5, univ: '', team: 'Y' } }, cookie: adminCookie });
    assert.equal(r3.status, 400); // univ 빈값
  });

  it('select allows clearing (null team/name)', async () => {
    const res = await client.post('/api/wireless/select', { body: { event_type: '가속', team: null, event_name: null }, cookie: adminCookie });
    assert.equal(res.status, 200);
  });

  it('DNF rejected when event not armed (400)', async () => {
    const ev = '오토크로스';
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 4, univ: 'A', team: 'B' }, event_name: 'ENG-NOARM-DNF' }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    const res = await client.post('/api/wireless/dnf', { body: { event_type: ev }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('does NOT save a negative (out-of-order) result', async () => {
    const ev = '오토크로스';
    const NS = 'eng-neg-s', NF = 'eng-neg-f', NAME = 'ENG-NEG';
    await client.put(`/api/wireless/mapping/${NS}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.put(`/api/wireless/mapping/${NF}`, { body: { event_type: ev, role: 'finish' }, cookie: adminCookie });
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 6, univ: 'A', team: 'B' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000' }, cookie: adminCookie });
    // 출발 tick=3200000000(200000ms), 도착 tick=1600000000(100000ms) → 도착이 앞섬 → 음수 → 미저장
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NS, master_tick: '3200000000', ev_seq: 1 }] }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NF, master_tick: '1600000000', ev_seq: 1 }] }, cookie: adminCookie });
    const list = await (await client.get('/api/records', { cookie: adminCookie })).json();
    assert.ok(!list.includes(`FSK ${YEAR} ${NAME}`), '음수 결과는 저장하지 않음');
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NS}`, { cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NF}`, { cookie: adminCookie });
  });

  // bind-at-arm: arm 본문에 실린 팀으로 귀속이 고정 → arm 후 select가 팀을 바꿔도 기록은 arm 시점 팀.
  it('binds team at arm; a later select change does NOT re-attribute the record', async () => {
    const ev = '오토크로스';
    const NS = 'bind-s', NF = 'bind-f', NAME = 'ENG-BIND';
    await client.put(`/api/wireless/mapping/${NS}`, { body: { event_type: ev, role: 'start' }, cookie: adminCookie });
    await client.put(`/api/wireless/mapping/${NF}`, { body: { event_type: ev, role: 'finish' }, cookie: adminCookie });
    // arm 본문에 팀A(num 21) + event_name을 실어 bind-at-arm
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'green', green_tick: '1600000000', team: { num: 21, univ: 'AU', team: 'TeamA' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NS, master_tick: '1600000000', ev_seq: 1 }] }, cookie: adminCookie }); // 출발
    // 런 진행 중 팀B(num 22)로 select 변경 — 귀속은 바뀌면 안 됨
    await client.post('/api/wireless/select', { body: { event_type: ev, team: { num: 22, univ: 'BU', team: 'TeamB' }, event_name: NAME }, cookie: adminCookie });
    await client.post('/api/wireless/ingest', { body: { events: [{ node_id: NF, master_tick: '1600160000', ev_seq: 1 }] }, cookie: adminCookie }); // 도착(10ms)
    const rows = await (await client.get(`/api/records/${encodeURIComponent(`FSK ${YEAR} ${NAME}`)}`, { cookie: adminCookie })).json();
    assert.ok(rows.some((r) => r.num === 21 && r.team === 'TeamA' && r.result === 10), 'arm 시점 팀A로 귀속');
    assert.ok(!rows.some((r) => r.num === 22), '중간 select의 팀B로 귀속되지 않음');
    await client.delete(`/api/records/${encodeURIComponent(`FSK ${YEAR} ${NAME}`)}`, { cookie: adminCookie });
    await client.post('/api/wireless/arm', { body: { event_type: ev, action: 'off' }, cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NS}`, { cookie: adminCookie });
    await client.delete(`/api/wireless/mapping/${NF}`, { cookie: adminCookie });
  });

  it('arm green rejects a malformed team in the body (400)', async () => {
    const res = await client.post('/api/wireless/arm', { body: { event_type: '가속', action: 'green', green_tick: '100', team: { num: 0, univ: 'X', team: 'Y' } }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('ingest rejects an event with a missing master_tick', async () => {
    const res = await client.post('/api/wireless/ingest', { body: { events: [{ node_id: 'no-tick', ev_seq: 1 }] }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stored, 0, 'master_tick 없는 이벤트는 저장 안 함');
    assert.equal(body.rejected, 1, 'rejected로 계수');
  });

  it('ingest rejects an event with a missing ev_seq so dedupe cannot be bypassed by NULL', async () => {
    const event = { node_id: 'no-seq', master_tick: '123456' };
    const r1 = await client.post('/api/wireless/ingest', { body: { events: [event] }, cookie: adminCookie });
    const r2 = await client.post('/api/wireless/ingest', { body: { events: [event] }, cookie: adminCookie });
    assert.equal((await r1.json()).stored, 0);
    const body = await r2.json();
    assert.equal(body.stored, 0, 'ev_seq 없는 이벤트는 저장 안 함');
    assert.equal(body.rejected, 1, '재전송도 rejected로 계수');
    const count = db.prepare("SELECT COUNT(*) AS c FROM wireless_event WHERE node_id = ? AND master_tick = ?").get('no-seq', '123456').c;
    assert.equal(count, 0, 'NULL ev_seq 중복 row가 남지 않아야 함');
  });

  it('persists structured warnings for early wireless business rejections', async () => {
    const beforeId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM logs').get().id;
    const oversized = Array.from({ length: 201 }, (_, index) => ({
      node_id: `oversized-${index}`, master_tick: String(index + 1), ev_seq: index + 1,
    }));
    const requests = [
      client.post('/api/wireless/ingest', { body: { events: oversized }, cookie: adminCookie }),
      client.post('/api/wireless/select', { body: { event_type: '짐카나' }, cookie: adminCookie }),
      client.post('/api/wireless/select', {
        body: { event_type: '가속', team: { num: 0, univ: 'X', team: 'Y' } }, cookie: adminCookie,
      }),
      client.post('/api/wireless/arm', {
        body: { event_type: '가속', action: 'green', green_tick: {} }, cookie: adminCookie,
      }),
      client.post('/api/wireless/command', {
        body: { event_type: '가속', action: 'blink' }, cookie: adminCookie,
      }),
      client.post('/api/wireless/lease/짐카나', { cookie: adminCookie }),
      client.delete('/api/wireless/lease/짐카나', { cookie: adminCookie }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [400, 400, 400, 400, 400, 400, 400]);

    await client.post('/api/wireless/select', {
      body: { event_type: '오토크로스', team: { num: 4, univ: 'A', team: 'B' }, event_name: 'AUDIT-DNF' },
      cookie: adminCookie,
    });
    await client.post('/api/wireless/arm', {
      body: { event_type: '오토크로스', action: 'off' }, cookie: adminCookie,
    });
    const dnf = await client.post('/api/wireless/dnf', {
      body: { event_type: '오토크로스' }, cookie: adminCookie,
    });
    assert.equal(dnf.status, 400);

    const warnings = db.prepare(`
      SELECT action, actor_email, target, detail FROM logs
      WHERE id > ? AND level = 'warn'
        AND action IN ('wireless.ingest', 'wireless.select', 'wireless.arm', 'wireless.command', 'wireless.lease', 'wireless.dnf')
      ORDER BY id
    `).all(beforeId);
    const actions = new Set(warnings.map((row) => row.action));
    assert.deepEqual(actions, new Set([
      'wireless.ingest', 'wireless.select', 'wireless.arm', 'wireless.command', 'wireless.lease', 'wireless.dnf',
    ]));
    for (const row of warnings) {
      const detail = JSON.parse(row.detail);
      assert.equal(row.actor_email, 'admin@test.com');
      assert.equal(typeof detail.operation, 'string');
      assert.equal(typeof detail.reason, 'string');
      assert.ok(row.target);
    }
  });
});

describe('Traffic TeamStore query-port failure auditing', () => {
  it('returns controlled select and green-arm failures with stable team context', async () => {
    const failingPath = tmpDbPath();
    const failingStore = {
      getById: () => { throw new Error('injected traffic team lookup failure'); },
    };
    const created = createTrafficApp({
      dbPath: failingPath,
      validateUser: TRUST_JWT,
      teamStore: failingStore,
    });
    const started = await startServer(created.app);
    const isolated = createClient(started.baseUrl);
    const team = { id: 91, teamId: 91, num: 91, univ: 'Lookup U', team: 'Lookup T' };
    try {
      const select = await isolated.post('/api/wireless/select', {
        body: { event_type: '가속', team, event_name: 'Lookup Select' },
        cookie: adminCookie,
      });
      assert.equal(select.status, 500);
      assert.equal(await select.text(), '팀 기준 정보를 확인할 수 없습니다.');

      const arm = await isolated.post('/api/wireless/arm', {
        body: { event_type: '가속', action: 'green', green_tick: '1', team, event_name: 'Lookup Arm' },
        cookie: adminCookie,
      });
      assert.equal(arm.status, 500);
      assert.equal(await arm.text(), '팀 기준 정보를 확인할 수 없습니다.');

      const logs = created.db.prepare(`
        SELECT action, detail FROM logs
        WHERE level = 'warn' AND action IN ('wireless.select', 'wireless.arm')
        ORDER BY id
      `).all();
      assert.deepEqual(logs.map((row) => row.action), ['wireless.select', 'wireless.arm']);
      for (const row of logs) {
        assert.deepEqual(JSON.parse(row.detail), {
          error: 'injected traffic team lookup failure',
          phase: 'canonical_team_lookup',
          event_type: '가속',
          year: CURRENT_YEAR,
          team_id: 91,
        });
      }
    } finally {
      await stopServer(started.server);
      for (const timer of created.timers || []) clearInterval(timer);
      created.closeSse?.();
      created.db.close();
      cleanup(failingPath);
    }
  });
});

describe('Traffic mutation state preflight auditing', () => {
  it('returns controlled audited failures for every session/light consumer and event-mode lookup', async () => {
    const isolatedPath = tmpDbPath();
    const rawDb = new Database(isolatedPath);
    let failSession = false;
    let failEventMode = false;
    const proxyDb = new Proxy(rawDb, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (failSession && sql.includes('FROM wireless_session ORDER BY event_type')) {
              throw new Error('injected wireless session preflight failure');
            }
            if (failEventMode && sql.includes('SELECT enabled FROM event_mode WHERE event_type = ?')) {
              throw new Error('injected event mode preflight failure');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const created = createTrafficApp({ db: proxyDb, validateUser: TRUST_JWT });
    for (const timer of created.timers || []) clearInterval(timer);
    const started = await startServer(created.app);
    const isolated = createClient(started.baseUrl);
    try {
      failSession = true;
      const requests = [
        () => isolated.post('/api/wireless/arm', {
          body: { event_type: '가속', action: 'off' }, cookie: adminCookie,
        }),
        () => isolated.post('/api/wireless/select', {
          body: { event_type: '가속', team: null, event_name: null }, cookie: adminCookie,
        }),
        () => isolated.post('/api/wireless/dnf', {
          body: { event_type: '가속' }, cookie: adminCookie,
        }),
        () => isolated.post('/api/wireless/command', {
          body: { event_type: '가속', action: 'off' }, cookie: adminCookie,
        }),
        () => isolated.post('/api/wireless/lease/가속', { cookie: adminCookie }),
        () => isolated.delete('/api/wireless/lease/가속', { cookie: adminCookie }),
      ];
      const responses = [];
      for (const request of requests) responses.push(await request());
      assert.deepEqual(responses.map((response) => response.status), [500, 500, 500, 500, 500, 500]);
      for (const response of responses) assert.match(await response.text(), /상태를 확인할 수 없습니다/);

      failSession = false;
      failEventMode = true;
      const eventMode = await isolated.put('/api/event-modes/가속', { cookie: adminCookie });
      assert.equal(eventMode.status, 500);
      assert.equal(await eventMode.text(), '경기 모드 상태를 확인할 수 없습니다.');
      failEventMode = false;

      const warnings = rawDb.prepare(`
        SELECT action, target, detail FROM logs
        WHERE level = 'warn' AND action IN (
          'wireless.arm', 'wireless.select', 'wireless.dnf', 'wireless.command', 'wireless.lease',
          'event_mode.toggle'
        ) ORDER BY id
      `).all();
      assert.deepEqual(warnings.map((row) => row.action), [
        'wireless.arm', 'wireless.select', 'wireless.dnf', 'wireless.command',
        'wireless.lease', 'wireless.lease', 'event_mode.toggle',
      ]);
      for (const row of warnings) {
        const detail = JSON.parse(row.detail);
        assert.equal(detail.phase, 'mutation_preflight');
        assert.equal(row.target, '가속');
        assert.match(detail.error, /injected (wireless session|event mode) preflight failure/);
        assert.equal(typeof detail.operation, 'string');
      }
    } finally {
      failSession = false;
      failEventMode = false;
      await stopServer(started.server);
      created.closeSse?.();
      rawDb.close();
      cleanup(isolatedPath);
    }
  });
});

describe('Traffic record and background mutation auditing', () => {
  it('audits record preflight rejections and throwing lookups', async () => {
    const isolatedPath = tmpDbPath();
    const rawDb = new Database(isolatedPath);
    rawDb.exec(`
      CREATE TABLE competition_team (
        id INTEGER PRIMARY KEY,
        year INTEGER NOT NULL,
        num INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      INSERT INTO competition_team (id, year, num, active) VALUES
        (1, ${CURRENT_YEAR}, 1, 1),
        (2, ${CURRENT_YEAR}, 2, 0);
    `);
    let failRecordLookup = false;
    const proxyDb = new Proxy(rawDb, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (failRecordLookup && sql.includes('SELECT 1 FROM record WHERE name = ? LIMIT 1')) {
              throw new Error('injected traffic record lookup failure');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const created = createTrafficApp({ db: proxyDb, validateUser: TRUST_JWT });
    for (const timer of created.timers || []) clearInterval(timer);
    const started = await startServer(created.app);
    const isolated = createClient(started.baseUrl);
    const activeName = `FSK ${CURRENT_YEAR} Audit Active`;
    const inactiveName = `FSK ${CURRENT_YEAR} Audit Inactive`;
    try {
      const create = await isolated.post('/api/records', {
        body: {
          name: 'Audit Active',
          data: {
            time: '2026-01-01T00:00:00.000Z',
            type: '가속',
            entry: { num: 1, univ: 'Active U', team: 'Active T' },
            result: 1000,
          },
        },
        cookie: adminCookie,
      });
      assert.equal(create.status, 201, await create.text());
      rawDb.prepare(`
        INSERT INTO record (name, legacy_rowid, time, num, univ, team, type, result)
        VALUES (?, 1, '2026-01-01T00:00:00.000Z', 2, 'Inactive U', 'Inactive T', '가속', 1000)
      `).run(inactiveName);

      const missingTable = await isolated.patch(`/api/records/${encodeURIComponent(`FSK ${CURRENT_YEAR} Missing`)}/1`, {
        body: { field: 'detail', value: 'x' }, cookie: adminCookie,
      });
      const missingRow = await isolated.patch(`/api/records/${encodeURIComponent(activeName)}/999`, {
        body: { field: 'detail', value: 'x' }, cookie: adminCookie,
      });
      const inactive = await isolated.patch(`/api/records/${encodeURIComponent(inactiveName)}/1`, {
        body: { field: 'detail', value: 'x' }, cookie: adminCookie,
      });
      const missingDelete = await isolated.delete('/api/records/MissingDelete', { cookie: adminCookie });
      const missingVisibility = await isolated.put('/api/records/MissingVisibility/visibility', { cookie: adminCookie });
      assert.deepEqual(
        [missingTable.status, missingRow.status, inactive.status, missingDelete.status, missingVisibility.status],
        [404, 404, 409, 404, 404],
      );

      failRecordLookup = true;
      const failedLookup = await isolated.patch(`/api/records/${encodeURIComponent(activeName)}/1`, {
        body: { field: 'detail', value: 'x' }, cookie: adminCookie,
      });
      assert.equal(failedLookup.status, 500);
      assert.equal(await failedLookup.text(), '기록 정보를 확인할 수 없습니다.');
      failRecordLookup = false;

      const warnings = rawDb.prepare(`
        SELECT action, actor_email, detail FROM logs
        WHERE level = 'warn' AND action IN ('record.update', 'record.delete', 'record.visibility')
        ORDER BY id
      `).all();
      assert.deepEqual(warnings.map((row) => row.action), [
        'record.update', 'record.update', 'record.update',
        'record.delete', 'record.visibility', 'record.update',
      ]);
      assert.ok(warnings.every((row) => row.actor_email === 'admin@test.com'));
      const details = warnings.map((row) => JSON.parse(row.detail));
      assert.deepEqual(details.slice(0, 5).map((detail) => detail.reason_code), [
        'record_not_found', 'record_row_not_found', 'inactive_or_missing_team',
        'record_not_found', 'record_not_found',
      ]);
      assert.equal(details[5].error, 'injected traffic record lookup failure');
      assert.equal(details[5].phase, 'record_preflight');
    } finally {
      await stopServer(started.server);
      created.closeSse?.();
      rawDb.close();
      cleanup(isolatedPath);
    }
  });

  it('audits lease expiry and event retention successes through exported callbacks', () => {
    const isolatedPath = tmpDbPath();
    const created = createTrafficApp({
      dbPath: isolatedPath,
      validateUser: TRUST_JWT,
    });
    for (const timer of created.timers || []) clearInterval(timer);
    try {
      created.db.prepare(`
        UPDATE wireless_session
        SET controller = 'expired@test.invalid#tab', lease_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE event_type = '가속'
      `).run();
      const lease = created.runLeaseWatch();
      assert.equal(lease.expired, 1);
      const leaseLog = created.db.prepare(`
        SELECT actor_email, detail FROM logs
        WHERE action = 'wireless.lease.expire' AND target = '가속'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(leaseLog.actor_email, 'system');
      assert.deepEqual(JSON.parse(leaseLog.detail), {
        event_type: '가속',
        before: {
          controller: 'expired@test.invalid#tab',
          lease_expires_at: '2000-01-01T00:00:00.000Z',
        },
        after: { controller: null, lease_expires_at: null },
      });

      const insert = created.db.prepare(`
        INSERT INTO wireless_event (id, node_id, master_tick, ev_seq) VALUES (?, ?, ?, ?)
      `);
      for (const id of [1, 2, 500001, 500002]) insert.run(id, `retention-${id}`, String(id), id % 65536);
      const retention = created.runEventRetention();
      assert.deepEqual(retention, { skipped: false, removed: 2, cutoff: 2 });
      assert.deepEqual(
        created.db.prepare('SELECT id FROM wireless_event ORDER BY id').all().map((row) => row.id),
        [500001, 500002],
      );
      const retentionLog = created.db.prepare(`
        SELECT actor_email, detail FROM logs
        WHERE action = 'wireless.event.retention' AND level = 'info'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(retentionLog.actor_email, 'system');
      assert.deepEqual(JSON.parse(retentionLog.detail), {
        cutoff_id: 2,
        removed: 2,
        retained_limit: 500000,
      });
    } finally {
      created.closeSse?.();
      created.db.close();
      cleanup(isolatedPath);
    }
  });
});

// ─── Legacy per-record table → normalized `record` migration ─────────────
describe('Traffic legacy record consolidation migration', () => {
  let migPath, migDb;
  const LEGACY = 'FSK 2026 Accel';

  before(() => {
    migPath = tmpDbPath();
    const seed = new Database(migPath);
    // A legacy per-record dynamic table WITHOUT invalidated/scoreboard/cones/oc
    // (those must be backfilled). rowid order must be preserved as legacy_rowid.
    seed.exec(`CREATE TABLE '${LEGACY}' (time TEXT, num INTEGER, univ TEXT, team TEXT, type TEXT, result INTEGER, detail TEXT)`);
    const ins = seed.prepare(`INSERT INTO '${LEGACY}' (time, num, univ, team, type, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run('2026-01-01T10:00:00Z', 5, 'U5', 'T5', '가속', 45000, 'd5'); // rowid 1
    ins.run('2026-01-01T10:05:00Z', 6, 'U6', 'T6', '가속', 46000, null); // rowid 2
    // A non-record table (missing required columns) must survive untouched.
    seed.exec(`CREATE TABLE random_notes (foo TEXT)`);
    seed.prepare("INSERT INTO random_notes (foo) VALUES ('keep me')").run();
    seed.close();
  });

  after(() => {
    migDb?.close();
    cleanup(migPath);
  });

  it('absorbs the legacy table into `record` preserving rowid order, backfills columns, and drops it', () => {
    migDb = createTrafficApp({ dbPath: migPath, validateUser: TRUST_JWT }).db;

    const rows = migDb.prepare("SELECT legacy_rowid, num, detail, invalidated, scoreboard, cones, oc FROM record WHERE name = ? ORDER BY legacy_rowid").all(LEGACY);
    assert.equal(rows.length, 2);
    // legacy rowid preserved and ordered
    assert.deepEqual(rows.map((r) => [r.legacy_rowid, r.num]), [[1, 5], [2, 6]]);
    assert.equal(rows[0].detail, 'd5');
    assert.equal(rows[1].detail, null);
    // backfilled defaults
    assert.deepEqual(rows.map((r) => [r.invalidated, r.scoreboard, r.cones, r.oc]), [[0, 1, 0, 0], [0, 1, 0, 0]]);

    // visibility seeded, legacy table dropped, non-record table untouched
    assert.equal(migDb.prepare("SELECT visible FROM record_visibility WHERE name = ?").get(LEGACY).visible, 1);
    const has = (t) => !!migDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    assert.equal(has(LEGACY), false, 'legacy per-record table dropped after import');
    assert.equal(has('random_notes'), true, 'non-record table must not be migrated or dropped');
  });

  it('is idempotent — re-opening the consolidated DB does not duplicate or error', () => {
    migDb.close();
    migDb = createTrafficApp({ dbPath: migPath, validateUser: TRUST_JWT }).db;
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM record WHERE name = ?").get(LEGACY).c, 2, 'no duplicate rows on re-run');
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name = 'random_notes'").get().c, 1);
  });
});
