import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../score/node_modules/express/index.js');
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
  TEST_INTERNAL_SECRET,
  startFakeEntryServer,
} from '../helpers/test-utils.mjs';
import { createScoreApp } from '../../score/index.mjs';

// ─── Mock Servers ───────────────────────────────────────────────────────

let mockEntryRequestCount = 0;
let mockEntryResponseDelayMs = 0;
let mockEntryTeamName = '팀A';
let mockEntryVersion = 1;

// entry의 team-state 스냅샷을 흉내낸다 (num 키 /api/entries가 아니라 id 키 team-state —
// score는 이제 HTTP /api/entries를 호출하지 않는다). 팀 1=id 101, 팀 2=id 102.
function createMockEntryServer() {
  const app = express();
  app.get('/api/internal/team-state', (req, res) => {
    mockEntryRequestCount++;
    const year = Number(req.query.year);
    const energyIntegration = [2087, 2088].includes(year);
    const payload = {
      year,
      version: mockEntryVersion,
      teams: {
        101: { num: 1, univ: '서울대', team: mockEntryTeamName, type: energyIntegration ? 'C-Formula' : 'EV', active: true },
        102: { num: 2, univ: '카이스트', team: '팀B', type: energyIntegration ? 'E-Formula' : 'EV', active: true },
      },
      tombstones: [],
    };
    if (mockEntryResponseDelayMs > 0) setTimeout(() => res.json(payload), mockEntryResponseDelayMs);
    else res.json(payload);
  });
  return app;
}

// 집계마다 호출되므로(재집계 관측점) 카운터·지연을 노출한다 — entry는 이제
// team-state 캐시라 집계 횟수와 무관하다.
let mockInspectionRequestCount = 0;
let mockInspectionResponseDelayMs = 0;

function createMockInspectionServer() {
  const app = express();
  app.get('/api/sheet/summary', (req, res) => {
    mockInspectionRequestCount++;
    const payload = {
      categories: [{ id: 1, name: '코너웨이트' }],
      teams: {}
    };
    if (mockInspectionResponseDelayMs > 0) setTimeout(() => res.json(payload), mockInspectionResponseDelayMs);
    else res.json(payload);
  });
  app.get('/api/sheet/template', (req, res) => {
    res.json([]);
  });
  app.get('/api/sheet/bulk-answers', (req, res) => {
    res.json({});
  });
  return app;
}

function createMockTrafficServer() {
  const app = express();
  const records = [
    { rowid: 1, time: '2026-01-01T10:00:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 50000, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
    { rowid: 2, time: '2026-01-01T10:05:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 48000, cones: 1, oc: 0, invalidated: 0, scoreboard: 1 },
    { rowid: 3, time: '2026-01-01T10:10:00', num: 2, univ: '카이스트', team: '팀B', type: '가속', result: 52000, cones: 0, oc: 1, invalidated: 0, scoreboard: 1 },
  ];
  app.get('/api/records/year/:year', (req, res) => {
    res.json([{ name: `FSK ${req.params.year} 가속 1차`, records }]);
  });
  app.get('/api/event-modes', (req, res) => {
    res.json([
      { event_type: '가속', enabled: 1 },
      { event_type: '스키드패드', enabled: 1 },
    ]);
  });
  return app;
}

function createRichMockInspectionServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/sheet/summary', (req, res) => {
    res.json({ categories: [{ id: 100, name: '코너웨이트' }], teams: {} });
  });

  // Return a template tree with 코너웨이트 category containing all 5 required items
  app.get('/api/sheet/template', (req, res) => {
    res.json([{
      id: 100, year: 2026, level: 'category', name: '코너웨이트', sort_order: 0,
      subcategories: [{
        id: 101, year: 2026, level: 'subcategory', name: '측정', sort_order: 0, parent_id: 100,
        groups: [{
          id: 102, year: 2026, level: 'group', name: '값', sort_order: 0, parent_id: 101,
          items: [
            { id: 201, name: '공차중량', answer_type: 'number', year: 2026, level: 'item', sort_order: 0 },
            { id: 202, name: 'FL', answer_type: 'number', year: 2026, level: 'item', sort_order: 1 },
            { id: 203, name: 'FR', answer_type: 'number', year: 2026, level: 'item', sort_order: 2 },
            { id: 204, name: 'RL', answer_type: 'number', year: 2026, level: 'item', sort_order: 3 },
            { id: 205, name: 'RR', answer_type: 'number', year: 2026, level: 'item', sort_order: 4 },
          ],
        }],
      }],
    }]);
  });

  // Return bulk answers for corner weight items
  app.get('/api/sheet/bulk-answers', (req, res) => {
    res.json({
      1: { 201: '250', 202: '63', 203: '62', 204: '64', 205: '61' },
    });
  });

  return app;
}

function createRichMockTrafficServer() {
  const app = express();
  const year = new Date().getFullYear();

  // 실제 traffic의 /api/records/year/:year 형태(가시 테이블 + 기록 일괄)를 흉내낸다.
  app.get('/api/records/year/:year', (req, res) => {
    res.json([
      {
        // Two tables for same event type "가속" (multi-table merge test)
        name: `FSK ${year} 가속 1차`,
        records: [
          // Team 1: valid run
          { rowid: 1, time: 'T1', num: 1, univ: 'A', team: 'A', type: '가속', result: 50000, cones: 1, oc: 0, invalidated: 0, scoreboard: 1 },
          // Team 2: invalidated run
          { rowid: 2, time: 'T2', num: 2, univ: 'B', team: 'B', type: '가속', result: 48000, cones: 0, oc: 0, invalidated: 1, scoreboard: 0 },
          // Team 3: DNF run (result < 0)
          { rowid: 3, time: 'T3', num: 3, univ: 'C', team: 'C', type: '가속', result: -1, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
        ],
      },
      {
        name: `FSK ${year} 가속 2차`,
        records: [
          // Team 1: another run (worse time) - tests multi-table merge + best run selection
          { rowid: 4, time: 'T4', num: 1, univ: 'A', team: 'A', type: '가속', result: 55000, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
          // Team 2: another run (also invalidated) - all runs invalidated → result: null
          { rowid: 5, time: 'T5', num: 2, univ: 'B', team: 'B', type: '가속', result: 49000, cones: 0, oc: 0, invalidated: 1, scoreboard: 0 },
          // Team 3: another DNF run - all valid but all DNF → result: -1
          { rowid: 6, time: 'T6', num: 3, univ: 'C', team: 'C', type: '가속', result: -1, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
        ],
      },
      {
        name: `FSK ${year} 스키드패드`,
        records: [
          { rowid: 7, time: 'T7', num: 1, univ: 'A', team: 'A', type: '스키드패드', result: 30000, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
        ],
      },
    ]);
  });

  app.get('/api/event-modes', (req, res) => {
    res.json([
      { event_type: '가속', enabled: 1 },
      { event_type: '스키드패드', enabled: 0 }, // DISABLED - should be excluded
      { event_type: '오토크로스', enabled: 1 },  // enabled but no records
    ]);
  });

  return app;
}

// ─── Setup ──────────────────────────────────────────────────────────────

setupTestEnv();

let server, baseUrl, client, db, dbPath;
let mockEntryServer, mockInspServer, mockTrafficServer;

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

before(async () => {
  // Start mock servers
  const entryApp = createMockEntryServer();
  const inspApp = createMockInspectionServer();
  const trafficApp = createMockTrafficServer();

  const [e, i, t] = await Promise.all([
    startServer(entryApp),
    startServer(inspApp),
    startServer(trafficApp),
  ]);
  mockEntryServer = e.server;
  mockInspServer = i.server;
  mockTrafficServer = t.server;

  process.env.ENTRY_SERVER = e.baseUrl;
  process.env.INSPECTION_SERVER = i.baseUrl;
  process.env.TRAFFIC_SERVER = t.baseUrl;

  dbPath = tmpDbPath();
  const result = createScoreApp({ dbPath, skipSSESubscriptions: true, validateUser: TRUST_JWT });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  await Promise.all([
    stopServer(mockEntryServer),
    stopServer(mockInspServer),
    stopServer(mockTrafficServer),
  ]);
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

// ─── Manual Scores ──────────────────────────────────────────────────────

describe('PUT /api/score/manual', () => {
  it('creates and updates a manual score', async () => {
    let res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 85 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 90 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const row = db.prepare(
      "SELECT value FROM score_manual WHERE year = 2026 AND team_num = 1 AND score_type = 'report'"
    ).get();
    assert.equal(row.value, 90);
  });

  it('rejects missing fields', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year range (too low)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 1999, team_num: 1, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year range (too high)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2100, team_num: 1, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates team_num (less than 1)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 0, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates score_type key length (>50 chars)', async () => {
    const longKey = 'a'.repeat(51);
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: longKey, value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects legacy manual energy scores', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 2, score_type: 'energy', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-finite value (NaN)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 'not-a-number' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Penalties ──────────────────────────────────────────────────────────

describe('PUT /api/score/penalty', () => {
  it('upserts a penalty config', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      db.prepare("SELECT cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = 2026 AND event_type = '가속'").get(),
      { cone_penalty: 2, oc_penalty: 10, start_delay: 5 }
    );
  });

  it('rejects missing fields', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative values', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '가속', cone_penalty: -1, oc_penalty: 0, start_delay: 0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('defaults null values to 0', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '스키드패드', cone_penalty: null, oc_penalty: null, start_delay: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      db.prepare("SELECT cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = 2026 AND event_type = '스키드패드'").get(),
      { cone_penalty: 0, oc_penalty: 0, start_delay: 0 }
    );
  });
});

// ─── Settings ───────────────────────────────────────────────────────────

describe('PUT /api/score/setting', () => {
  it('upserts a score setting', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: 'total_score', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal(
      db.prepare("SELECT value FROM score_setting WHERE year = 2026 AND event_type = '가속' AND setting_key = 'total_score'").get().value,
      75
    );
  });

  it('validates event_type key (empty)', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '', setting_key: 'total_score', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates setting_key (empty)', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: '', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative values', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: 'total_score', value: -1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('allows null value', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '스키드패드', setting_key: 'cutoff', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal(
      db.prepare("SELECT value FROM score_setting WHERE year = 2026 AND event_type = '스키드패드' AND setting_key = 'cutoff'").get().value,
      null
    );
  });
});

// ─── Endurance ──────────────────────────────────────────────────────────

describe('GET /api/score/endurance (initial)', () => {
  it('returns empty object initially', async () => {
    const res = await client.get('/api/score/endurance?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, {});
  });
});

describe('PUT /api/score/endurance', () => {
  it('upserts a driver1_time field', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: 120000 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('accepts every supported status and allows clearing it', async () => {
    for (const status of ['DNF', 'DNS', 'DSQ', null]) {
      const res = await client.put('/api/score/endurance', {
        body: { year: 2026, team_num: 2, field: 'status', value: status },
        cookie: adminCookie,
      });
      assert.equal(res.status, 200);
      assert.equal(
        db.prepare('SELECT status FROM score_endurance WHERE year = 2026 AND team_num = 2').get().status,
        status
      );
    }
  });

  it('rejects invalid status', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'status', value: 'INVALID' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative numeric values', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: -1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('accepts energy fields and permits negative net electric energy only', async () => {
    const net = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'electric_net_energy', value: -0.5 },
      cookie: adminCookie,
    });
    assert.equal(net.status, 200);

    const fuel = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'fuel_consumed', value: -0.5 },
      cookie: adminCookie,
    });
    assert.equal(fuel.status, 400);
  });

  it('rejects manual energy type and DSQ reason, and validates the DSQ flag', async () => {
    const badType = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_type', value: 'E' },
      cookie: adminCookie,
    });
    assert.equal(badType.status, 400);

    const badDsq = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_dsq', value: 2 },
      cookie: adminCookie,
    });
    assert.equal(badDsq.status, 400);

    const reason = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_dsq_reason', value: '봉인 훼손' },
      cookie: adminCookie,
    });
    assert.equal(reason.status, 400);
  });

  it('rejects non-allowed field', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'hackerfield', value: 999 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year (too low)', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 1999, team_num: 1, field: 'driver1_time', value: 100 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates team_num (less than 1)', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 0, field: 'driver1_time', value: 100 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/score/endurance (after writes)', () => {
  it('returns set endurance data', async () => {
    const res = await client.get('/api/score/endurance?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Team 1 should have driver1_time = 120000
    assert.ok(data['1']);
    assert.equal(data['1'].driver1_time, 120000);
    // Team 2 should exist (status was set then cleared)
    assert.ok(data['2']);
    assert.equal(data['1'].fuel_extra, null);
    assert.equal('energy_dsq_reason' in data['1'], false);
  });
});

// ─── GET /api/score (main aggregation) ──────────────────────────────────

describe('GET /api/score', () => {
  // Set up a second manual score for team 2 to verify aggregation
  before(async () => {
    await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 2, score_type: 'report', value: 70 },
      cookie: adminCookie,
    });
  });

  it('rejects missing year', async () => {
    const res = await client.get('/api/score', { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('aggregates entries, inspection, event records, manual scores, penalties, and settings', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.entries);
    assert.ok(data.inspection);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.manualScores);
    assert.ok(data.penalties);
    assert.ok(data.settings);
    assert.equal(data.entries['1'].univ, '서울대');
    assert.equal(data.entries['2'].univ, '카이스트');

    const accelEvent = data.events.find(e => e.type === '가속');
    assert.ok(accelEvent, 'should have 가속 event');
    assert.ok(accelEvent.records, 'should have records');
    assert.ok(accelEvent.records['1'], 'team 1 should have records');
    assert.ok(accelEvent.records['2'], 'team 2 should have records');

    assert.equal(data.manualScores['1'].report, 90);
    assert.equal(data.manualScores['2'].report, 70);

    assert.ok(data.penalties['가속']);
    assert.equal(data.penalties['가속'].cone_penalty, 2);
    assert.equal(data.penalties['가속'].oc_penalty, 10);
    assert.equal(data.penalties['가속'].start_delay, 5);

    assert.ok(data.settings['가속']);
    assert.equal(data.settings['가속'].total_score, 75);

    const enduranceEvent = data.events.find(e => e.type === '내구');
    assert.ok(enduranceEvent, 'should have 내구 event');
    assert.ok(enduranceEvent.records, 'should have endurance records');
  });

  it('penalty calculation: best run selected with penalty-adjusted time', async () => {
    const year = new Date().getFullYear();
    // First set penalty config for current year
    await client.put('/api/score/penalty', {
      body: { year, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 0 },
      cookie: adminCookie,
    });

    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    const data = await res.json();
    const accelEvent = data.events.find(e => e.type === '가속');

    // Team 1 has two runs:
    //   Run 1: result=50000, cones=0, oc=0 → adjusted = 50000
    //   Run 2: result=48000, cones=1, oc=0 → adjusted = 48000 + 1*2*1000 = 50000
    // Both have the same adjusted time; the reduce picks the first (run 1)
    // So best result should be 50000 with cones=0
    assert.equal(accelEvent.records['1'].result, 50000);
    assert.equal(accelEvent.records['1'].cones, 0);

    // Team 2 has one run:
    //   Run 3: result=52000, cones=0, oc=1 → adjusted = 52000 + 0 + 1*10*1000 = 62000
    // Only one valid run, so that's the best
    assert.equal(accelEvent.records['2'].result, 52000);
    assert.equal(accelEvent.records['2'].cones, 0);
    assert.equal(accelEvent.records['2'].oc, 1);
  });

});

// ─── Endurance calculation in aggregation ────────────────────────────────

describe('Endurance calculation in aggregation', () => {
  it('DNS entry excluded from endurance results', async () => {
    // Set team 2 status to DNS
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNS' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.equal(endurance.records[2], undefined, 'DNS entry should be excluded');
  });

  it('DNF entry has result -1', async () => {
    // Set team 2 status to DNF
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNF' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[2], 'DNF entry should be present');
    assert.equal(endurance.records[2].result, -1, 'DNF should have result -1');
  });

  it('DSQ entry has result -1', async () => {
    // Set team 2 status to DSQ
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DSQ' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[2], 'DSQ entry should be present');
    assert.equal(endurance.records[2].result, -1, 'DSQ should have result -1');
  });

  it('calculates normal endurance time with all components', async () => {
    // Set up endurance penalty config
    await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '내구', cone_penalty: 2, oc_penalty: 10, start_delay: 5 },
    });

    // Clear status for team 1
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'status', value: null },
    });
    // Set all time fields for team 1
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: 60000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_time', value: 65000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver_change_time', value: 5000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_start_delay', value: 2 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_start_delay', value: 1 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_cones', value: 3 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_cones', value: 2 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_oc', value: 1 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_oc', value: 0 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_penalty', value: 10 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_penalty', value: 5 },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[1], 'team 1 should have endurance record');

    // Expected calculation:
    // startDelayMs = (2 + 1) * 5 * 1000 = 15000
    // manualPenaltyMs = (10 + 5) * 1000 = 15000
    // result = 60000 + 65000 + 5000 + 15000 + 15000 = 160000
    assert.equal(endurance.records[1].result, 160000, 'endurance time should include all components');
    assert.equal(endurance.records[1].cones, 5, 'cones should be sum of both drivers');
    assert.equal(endurance.records[1].oc, 1, 'oc should be sum of both drivers');
  });

  it('skips endurance record when time fields are incomplete', async () => {
    // Clear team 2 status first so it's not DNS/DNF/DSQ
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: null },
    });
    // Set partial time fields (driver1_time and driver_change_time but NOT driver2_time)
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver1_time', value: 60000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver_change_time', value: 5000 },
    });
    // driver2_time is NOT set (null) — ensure it's null by clearing it
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver2_time', value: null },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    // Team 2 should be skipped because driver2_time is null
    assert.equal(endurance.records[2], undefined, 'incomplete endurance record should be skipped');
  });
});

describe('Energy score integration', () => {
  const year = 2088;

  before(() => {
    const insertSetting = db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', ?, ?)");
    insertSetting.run(year, 'total', 35);
    insertSetting.run(year, 'distance_km', 20);
    insertSetting.run(year, 'fuel_factor', 2.31);
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '보고서', 'total', ?)").run(year, 50);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO score_endurance
        (year, team_num, driver1_time, driver_change_time, driver2_time, fuel_consumed, electric_net_energy)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `);
    insert.run(year, 1, 50_000, 50_000, 1, null);
    insert.run(year, 2, 55_000, 55_000, null, 2);
  });

  it('returns energy scores with a blank driver-change overrun treated as zero', async () => {
    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.energy.config.total, 35);
    assert.equal(data.energy.teams['1'].status, 'SCORED');
    assert.equal(data.energy.teams['1'].energyType, 'C');
    assert.equal(data.energy.teams['1'].score, 35);
    assert.equal(data.energy.teams['2'].energyType, 'E');
    assert.equal(data.energy.teams['2'].score, 0);
  });

  it('enforces the configured report maximum', async () => {
    const over = await client.put('/api/score/manual', {
      cookie: adminCookie,
      body: { year, team_num: 1, score_type: 'report', value: 51 },
    });
    assert.equal(over.status, 400);

    const exact = await client.put('/api/score/manual', {
      cookie: adminCookie,
      body: { year, team_num: 1, score_type: 'report', value: 50 },
    });
    assert.equal(exact.status, 200);
  });

  it('returns corrected CO2/100km before endurance time and score settings are complete', async () => {
    const incompleteYear = 2087;
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', 'distance_km', ?)").run(incompleteYear, 20);
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', 'fuel_factor', ?)").run(incompleteYear, 2.31);
    db.prepare("INSERT OR REPLACE INTO score_endurance (year, team_num, fuel_consumed) VALUES (?, ?, ?)").run(incompleteYear, 1, 1);

    const res = await client.get(`/api/score?year=${incompleteYear}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.energy.teams['1'].status, 'PENDING');
    assert.equal(data.energy.teams['1'].correctedCo2, 2.31);
    assert.equal(data.energy.teams['1'].co2Per100Km, 11.55);
    assert.equal(data.energy.teams['1'].score, null);
  });

  it('calculates a numeric score after the energy total is entered in the score table', async () => {
    const scoringYear = 2087;
    for (const field of ['driver1_time', 'driver2_time']) {
      const timeUpdate = await client.put('/api/score/endurance', {
        cookie: adminCookie,
        body: { year: scoringYear, team_num: 1, field, value: 50_000 },
      });
      assert.equal(timeUpdate.status, 200);
    }

    const update = await client.put('/api/score/setting', {
      cookie: adminCookie,
      body: { year: scoringYear, event_type: '에너지', setting_key: 'total', value: 50 },
    });
    assert.equal(update.status, 200);

    const res = await client.get(`/api/score?year=${scoringYear}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.settings['에너지'].total, 50);
    assert.equal(data.energy.teams['1'].status, 'SCORED');
    assert.equal(data.energy.teams['1'].score, 50);
  });
});

// ─── Auth ───────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('PUT /api/score/manual without auth returns 401', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 50 },
    });
    assert.equal(res.status, 401);
  });

  it('keeps the full score aggregation private', async () => {
    const res = await client.get('/api/score?year=2026');
    assert.equal(res.status, 401);
  });
});

// ─── Public score publication ───────────────────────────────────────────

describe('Public score publication', () => {
  it('defaults to private and protects publication settings', async () => {
    const unauthenticated = await client.get('/api/score/publication?year=2026');
    assert.equal(unauthenticated.status, 401);

    const state = await client.get('/api/score/publication?year=2026', { cookie: adminCookie });
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { year: 2026, enabled: false });

    const publicData = await client.get('/api/score/public/2026');
    assert.equal(publicData.status, 404);

    const publicPage = await client.get('/public/2026');
    assert.equal(publicPage.status, 404);
  });

  it('validates publication updates', async () => {
    const badYear = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 1999, enabled: true },
    });
    assert.equal(badYear.status, 400);

    const badEnabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: 1 },
    });
    assert.equal(badEnabled.status, 400);
  });

  it('serves only the public table fields while enabled', async () => {
    const enabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: true },
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { year: 2026, enabled: true });

    mockEntryRequestCount = 0;
    const res = await client.get('/api/score/public/2026');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.year, 2026);
    assert.deepEqual(Object.keys(data).sort(), ['entries', 'events', 'year']);
    assert.deepEqual(data.entries['1'], { univ: '서울대', team: '팀A', type: 'EV' });
    assert.equal(data.events.some((event) => event.type === '내구'), false);
    assert.ok(data.events.some((event) => event.type === '가속'));
    assert.deepEqual(Object.keys(data.events.find((event) => event.type === '가속').records['1']), ['result']);

    const cached = await client.get('/api/score/public/2026');
    assert.equal(cached.status, 200);
    // team-state 캐시(TTL 30s)로 엔트리 스냅샷은 요청 수와 무관하게 최대 1회만 fetch된다
    // (다른 스위트가 이미 캐시를 데웠으면 0회).
    assert.ok(mockEntryRequestCount <= 1, 'sequential public requests must reuse the cached team state');
  });

  it('publishes refresh notifications over the public SSE stream', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/score/public/2026/events`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.headers.get('content-type')?.includes('text/event-stream'));

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    assert.match(initial, /event: init/);

    const update = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 3, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(update.status, 200);

    let message = '';
    await Promise.race([
      (async () => {
        while (!message.includes('event: refresh')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          message += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('public SSE refresh timeout')), 2000)),
    ]);
    assert.match(message, /event: refresh/);

    const before = mockInspectionRequestCount;
    const refreshed = await client.get('/api/score/public/2026');
    assert.equal(refreshed.status, 200);
    // penalty 변경이 공개 스냅샷을 무효화했으므로 재집계(= inspection 재조회)가 일어나야 한다
    assert.ok(mockInspectionRequestCount > before, 'score updates should invalidate the public snapshot');
    await reader.cancel();
    controller.abort();
  });

  // 집계 진행 중 무효화가 끼어들면 stale 스냅샷이 캐시로 남지 않아야 한다. 예전에는
  // entry fetch 타이밍으로 관측했지만 entry는 이제 team-state 캐시라, 집계마다 호출되는
  // inspection fetch로 "집계 시작"을 감지하고 점수-로컬 데이터(penalty)로 신선도를 검증한다.
  // 가속 기록(팀 1): 50000ms/콘 0, 48000ms/콘 1 → cone_penalty 1이면 48000이 최고 기록
  // (공개 payload 결과 49000), 3이면 50000이 최고 기록 (payload 50000).
  it('does not restore a stale snapshot when invalidated during aggregation', async () => {
    const initialUpdate = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 1, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(initialUpdate.status, 200);

    const requestCountBefore = mockInspectionRequestCount;
    mockInspectionResponseDelayMs = 100;
    const requestBeforeInvalidation = client.get('/api/score/public/2026');
    while (mockInspectionRequestCount === requestCountBefore) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const invalidatingUpdate = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 3, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(invalidatingUpdate.status, 200);
    const requestAfterInvalidation = client.get('/api/score/public/2026');

    try {
      const [beforeResponse, afterResponse] = await Promise.all([
        requestBeforeInvalidation,
        requestAfterInvalidation,
      ]);
      assert.equal(beforeResponse.status, 200);
      assert.equal(afterResponse.status, 200);
      // 공개 경로는 세대(generation)가 최신일 때까지 재집계하므로 둘 다 새 penalty 기준
      assert.equal((await beforeResponse.json()).events.find((e) => e.type === '가속').records['1'].result, 50000);
      assert.equal((await afterResponse.json()).events.find((e) => e.type === '가속').records['1'].result, 50000);
    } finally {
      mockInspectionResponseDelayMs = 0;
    }
  });

  it('does not reuse an invalidated in-flight aggregate for authenticated requests', async () => {
    const first = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 1, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(first.status, 200);

    const requestCountBefore = mockInspectionRequestCount;
    mockInspectionResponseDelayMs = 100;
    const requestBeforeInvalidation = client.get('/api/score?year=2026', { cookie: adminCookie });
    while (mockInspectionRequestCount === requestCountBefore) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const invalidatingUpdate = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 3, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(invalidatingUpdate.status, 200);
    const requestAfterInvalidation = client.get('/api/score?year=2026', { cookie: adminCookie });

    try {
      const [beforeResponse, afterResponse] = await Promise.all([
        requestBeforeInvalidation,
        requestAfterInvalidation,
      ]);
      assert.equal(beforeResponse.status, 200);
      assert.equal(afterResponse.status, 200);
      // 핵심 불변식: 무효화 이후의 요청이 무효화 이전에 시작한 in-flight 집계를 재사용하면
      // 안 된다 → after는 반드시 새 penalty(3)를 본다. before는 찢긴 집계라 1/3 어느 쪽도
      // 가능(admin 경로는 재시도하지 않음) — 값 단언은 after에만 건다.
      assert.equal((await afterResponse.json()).penalties['가속'].cone_penalty, 3);
    } finally {
      mockInspectionResponseDelayMs = 0;
    }
  });

  it('blocks public data again immediately after publication is disabled', async () => {
    const disabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: false },
    });
    assert.equal(disabled.status, 200);

    const publicData = await client.get('/api/score/public/2026');
    assert.equal(publicData.status, 404);
    const publicEvents = await client.get('/api/score/public/2026/events');
    assert.equal(publicEvents.status, 404);
  });
});

// ─── Score aggregation business logic ────────────────────────────────────

describe('Score aggregation business logic', () => {
  let srv, url, cli, database, dp;
  let mEntry, mInsp, mTraffic;
  const cookie = adminCookie;
  const YEAR = new Date().getFullYear();

  before(async () => {
    // Rich entry mock with 3 teams (team-state 스냅샷 형태)
    const richEntryApp = express();
    richEntryApp.get('/api/internal/team-state', (req, res) => {
      res.json({
        year: Number(req.query.year),
        version: 1,
        teams: {
          201: { num: 1, univ: '서울대', team: '팀A', type: 'EV', active: true },
          202: { num: 2, univ: '카이스트', team: '팀B', type: 'EV', active: true },
          203: { num: 3, univ: '연세대', team: '팀C', type: 'EV', active: true },
        },
        tombstones: [],
      });
    });

    const [e, i, t] = await Promise.all([
      startServer(richEntryApp),
      startServer(createRichMockInspectionServer()),
      startServer(createRichMockTrafficServer()),
    ]);
    mEntry = e.server;
    mInsp = i.server;
    mTraffic = t.server;

    process.env.ENTRY_SERVER = e.baseUrl;
    process.env.INSPECTION_SERVER = i.baseUrl;
    process.env.TRAFFIC_SERVER = t.baseUrl;

    dp = tmpDbPath();
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true, validateUser: TRUST_JWT });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
  });

  after(async () => {
    await stopServer(srv);
    await Promise.all([
      stopServer(mEntry),
      stopServer(mInsp),
      stopServer(mTraffic),
    ]);
    database.close();
    cleanup(dp);
  });

  it('extracts corner weight data from inspection template', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.inspection.cornerWeight, 'cornerWeight should be present');
    assert.equal(data.inspection.cornerWeight.categoryId, 100);
    assert.ok(data.inspection.cornerWeight.items.curb, 'curb item ID should be set');
    assert.ok(data.inspection.cornerWeight.teams[1], 'team 1 corner weight data should exist');
    assert.equal(data.inspection.cornerWeight.teams[1].curb, '250');
    assert.equal(data.inspection.cornerWeight.teams[1].fl, '63');
    assert.equal(data.inspection.cornerWeight.teams[1].rr, '61');
  });

  it('merges records from multiple tables for same event type', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    assert.ok(accel, '가속 event should exist');

    // Team 1 has runs from both 가속 1차 and 가속 2차
    assert.ok(accel.records[1], 'team 1 should have records');
    assert.ok(accel.records[1].allRuns.length >= 2, 'team 1 should have runs from multiple tables');
  });

  it('excludes all-invalidated records (result: null)', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 2: both runs are invalidated → result should be null
    assert.ok(accel.records[2], 'team 2 should exist');
    assert.equal(accel.records[2].result, null, 'all-invalidated should have result null');
  });

  it('all-DNF valid runs produce result -1', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 3: both runs are DNF (result < 0) but not invalidated → result: -1
    assert.ok(accel.records[3], 'team 3 should exist');
    assert.equal(accel.records[3].result, -1, 'all-DNF should have result -1');
  });

  it('excludes disabled event modes from events', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const types = data.events.map(e => e.type);
    assert.ok(types.includes('가속'), '가속 (enabled) should be in events');
    assert.ok(!types.includes('스키드패드'), '스키드패드 (disabled) should NOT be in events');
    // 오토크로스 is enabled but has no records - should still appear with empty records
    assert.ok(types.includes('오토크로스'), '오토크로스 (enabled, no records) should be in events');
  });

  it('selects best run from merged multi-table records with penalty', async () => {
    // Set up penalty for 가속
    await cli.put('/api/score/penalty', {
      cookie,
      body: { year: YEAR, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 0 },
    });

    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 1: run1 = 50000 + 1*2*1000 = 52000, run2 = 55000 + 0 = 55000
    // Best = run1 (lower adjusted time)
    assert.equal(accel.records[1].result, 50000, 'best run from 가속 1차 should be selected');
    assert.equal(accel.records[1].cones, 1, 'best run cones should be from selected run');
  });
});

// ─── Record visibility filtering ──────────────────────────────────────

// NOTE: record-visibility 제외 자체(숨긴 테이블을 빼는 것)는 이제 traffic
// getYearRecordGroups가 담당하며 tests/traffic/traffic.test.mjs에서 직접 검증한다.
// 여기서는 score가 traffic year 응답(이미 필터된 상태)을 그대로 받아 종목별로
// pass-through 집계하는지만 확인한다 — mock은 필터된 결과(가속 1차만)를 반환한다.
describe('Score aggregation over the pre-filtered traffic year response', () => {
  let srv, url, cli, database, dp;
  let mEntry, mInsp, mTraffic;
  const cookie = adminCookie;
  const YEAR = new Date().getFullYear();

  before(async () => {
    const entryApp = express();
    entryApp.get('/api/internal/team-state', (req, res) => {
      res.json({
        year: Number(req.query.year), version: 1,
        teams: { 301: { num: 1, univ: 'A대', team: '팀A', type: 'EV', active: true } },
        tombstones: [],
      });
    });

    const inspApp = createMockInspectionServer();

    const trafficApp = express();
    // traffic year 엔드포인트가 이미 visibility 필터를 적용한 뒤의 응답을 흉내낸다
    // (가속 1차만 노출; 숨긴 테이블은 애초에 응답에 없음).
    trafficApp.get('/api/records/year/:year', (req, res) => {
      res.json([
        {
          name: `FSK ${YEAR} 가속 1차`,
          records: [{ rowid: 1, time: 'T1', num: 1, univ: 'A', team: 'A', type: '가속', result: 50000, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 }],
        },
      ]);
    });
    trafficApp.get('/api/event-modes', (req, res) => {
      res.json([{ event_type: '가속', enabled: 1 }]);
    });

    const [e, i, t] = await Promise.all([
      startServer(entryApp),
      startServer(inspApp),
      startServer(trafficApp),
    ]);
    mEntry = e.server; mInsp = i.server; mTraffic = t.server;

    process.env.ENTRY_SERVER = e.baseUrl;
    process.env.INSPECTION_SERVER = i.baseUrl;
    process.env.TRAFFIC_SERVER = t.baseUrl;

    dp = tmpDbPath();
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true, validateUser: TRUST_JWT });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server; url = started.baseUrl;
    cli = createClient(url);
  });

  after(async () => {
    await stopServer(srv);
    await Promise.all([stopServer(mEntry), stopServer(mInsp), stopServer(mTraffic)]);
    database.close();
    cleanup(dp);
  });

  it('aggregates only the tables present in the traffic year response', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    assert.ok(accel, '가속 event should exist');
    // traffic이 가속 1차(50000)만 돌려주므로 그 하나만 집계되어야 한다
    // (실제 숨김 필터링 검증은 tests/traffic/traffic.test.mjs).
    assert.equal(accel.records[1].result, 50000, 'should aggregate the single returned run');
    assert.equal(accel.records[1].allRuns.length, 1, 'no extra runs should appear');
  });
});

// ─── Team-state 수렴형 강제 (구 내부 라이프사이클 라우트 대체) ─────────────
// entry가 이벤트를 push하는 대신, score가 team-state 스냅샷을 pull해서 version 변경 시
// tombstone cascade·비정규화 갱신·비활성 필터를 멱등하게 적용한다.
describe('Team-state convergent enforcement', () => {
  let fake, srv, cli, database, dp, teamState;
  let mInsp, mTraffic;
  const YEAR = new Date().getFullYear();
  let version = 0;

  const baseTeams = () => ({
    301: { num: 31, univ: 'A대', team: '팀A', type: 'EV', active: true },
    302: { num: 32, univ: 'B대', team: '팀B', type: 'EV', active: true },
  });

  function publish(mutate = (s) => s) {
    version++;
    const snap = mutate({ version, teams: baseTeams(), tombstones: [] });
    snap.version = version;
    fake.setSnapshot(YEAR, snap);
    return teamState.refresh(YEAR);
  }

  before(async () => {
    fake = await startFakeEntryServer();
    const [i, t] = await Promise.all([
      startServer(createMockInspectionServer()),
      startServer(createMockTrafficServer()),
    ]);
    mInsp = i.server; mTraffic = t.server;
    process.env.ENTRY_SERVER = fake.url;
    process.env.INSPECTION_SERVER = i.baseUrl;
    process.env.TRAFFIC_SERVER = t.baseUrl;

    dp = tmpDbPath();
    // 레거시 행: 백필 검증용 — 팀 31의 옛 점수(team_id NULL) + entry가 모르는 번호 99
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true, validateUser: TRUST_JWT });
    database = result.db;
    teamState = result.teamState;
    database.prepare("INSERT INTO score_manual (year, team_num, score_type, value) VALUES (?, 31, 'report', 11)").run(YEAR);
    database.prepare("INSERT INTO score_manual (year, team_num, score_type, value) VALUES (?, 99, 'report', 1)").run(YEAR);
    const started = await startServer(result.app);
    srv = started.server;
    cli = createClient(started.baseUrl);
    await publish();
  });

  after(async () => {
    await stopServer(srv);
    await Promise.all([stopServer(mInsp), stopServer(mTraffic)]);
    await fake.close();
    database.close();
    cleanup(dp);
  });

  it('backfills team_id for legacy rows and leaves unknown teams NULL (never deleted)', () => {
    assert.equal(database.prepare("SELECT team_id FROM score_manual WHERE year = ? AND team_num = 31").get(YEAR).team_id, 301);
    const orphan = database.prepare("SELECT team_id, value FROM score_manual WHERE year = ? AND team_num = 99").get(YEAR);
    assert.equal(orphan.team_id, null, 'unknown team stays NULL');
    assert.equal(orphan.value, 1, 'unknown team row must not be deleted');
  });

  it('writes key by team_id and adopt legacy num rows', async () => {
    const res = await cli.put('/api/score/manual', {
      body: { year: YEAR, team_num: 31, score_type: 'report', value: 22 }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const row = database.prepare("SELECT team_id, value FROM score_manual WHERE year = ? AND team_num = 31 AND score_type = 'report'").get(YEAR);
    assert.deepEqual(row, { team_id: 301, value: 22 });
  });

  it('renumber+rename converge: denormalized num follows the immutable id', async () => {
    await publish((s) => {
      s.teams[301] = { num: 33, univ: 'A대', team: '팀A(정정)', type: 'EV', active: true };
      return s;
    });
    const row = database.prepare("SELECT team_num FROM score_manual WHERE year = ? AND team_id = 301 AND score_type = 'report'").get(YEAR);
    assert.equal(row.team_num, 33, 'team_num must follow the id after a renumber');
    // 집계에서도 새 번호 아래에 점수가 귀속된다
    const data = await (await cli.get(`/api/score?year=${YEAR}`, { cookie: adminCookie })).json();
    assert.equal(data.manualScores[33].report, 22);
    assert.equal(data.manualScores[31], undefined);
  });

  it('deactivation hides rows and blocks writes; reactivation restores (idempotent re-run safe)', async () => {
    const put = (v) => cli.put('/api/score/endurance', {
      body: { year: YEAR, team_num: 32, field: 'driver1_time', value: v }, cookie: adminCookie,
    });
    assert.equal((await put(1000)).status, 200);

    await publish((s) => { s.teams[302].active = false; return s; });
    const hidden = await (await cli.get(`/api/score/endurance?year=${YEAR}`, { cookie: adminCookie })).json();
    assert.equal(hidden[32], undefined, 'inactive team hidden from endurance list');
    assert.equal((await put(2000)).status, 409, 'writes to an inactive team are rejected');
    const aggregate = await (await cli.get(`/api/score?year=${YEAR}`, { cookie: adminCookie })).json();
    assert.equal(aggregate.entries[32], undefined);

    // 같은 스냅샷 재적용(멱등) 후 재활성화
    await teamState.refresh(YEAR);
    await publish();
    const restored = await (await cli.get(`/api/score/endurance?year=${YEAR}`, { cookie: adminCookie })).json();
    assert.equal(restored[32].driver1_time, 1000, 'reactivation restores preserved data');
  });

  it('tombstones cascade-delete the team rows by id', async () => {
    await publish((s) => {
      delete s.teams[302];
      s.tombstones = [{ id: 302, num: 32, deleted_at: '2026-01-01T00:00:00.000Z' }];
      return s;
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM score_endurance WHERE year = ? AND team_id = 302").get(YEAR).c, 0);
    // 모르는 팀(99)은 여전히 보존
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM score_manual WHERE year = ? AND team_num = 99").get(YEAR).c, 1);
  });

  // 회귀: 같은 번호의 팀 교체 직후, 낡은 캐시로 num→id를 해석하면 점수가 tombstone된
  // 옛 id에 달렸다가 다음 수렴에서 삭제됐다. 정체성 부여 쓰기는 강제 refresh로 최신
  // 매핑을 받아야 한다 — 캐시를 낡게 만든 채(스냅샷만 교체, refresh 안 함) 쓰기를 보낸다.
  it('identity-assigning writes resolve against a fresh snapshot, not the stale cache', async () => {
    // 현재 캐시는 num 31 → id 301. 같은 번호(31)의 새 팀 309로 교체한 스냅샷을 fake에만
    // 심고 teamState.refresh는 부르지 않는다 — 캐시가 낡은 상태에서 쓰기를 보낸다.
    version++;
    fake.setSnapshot(YEAR, {
      version,
      teams: { 309: { num: 31, univ: 'C대', team: '팀C', type: 'EV', active: true } },
      tombstones: [
        { id: 301, num: 31, deleted_at: '2026-01-02T00:00:00.000Z' },
        { id: 302, num: 32, deleted_at: '2026-01-01T00:00:00.000Z' },
      ],
    });

    const res = await cli.put('/api/score/manual', {
      body: { year: YEAR, team_num: 31, score_type: 'report', value: 77 }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const row = database.prepare(
      "SELECT team_id FROM score_manual WHERE year = ? AND team_num = 31 AND score_type = 'report'",
    ).get(YEAR);
    assert.equal(row.team_id, 309, 'write must land on the fresh team id, not the tombstoned one');

    // 수렴을 한 번 더 돌려도(같은 스냅샷) 점수가 살아남는다
    await teamState.refresh(YEAR);
    assert.equal(database.prepare(
      "SELECT value FROM score_manual WHERE year = ? AND team_id = 309 AND score_type = 'report'",
    ).get(YEAR).value, 77);
  });

  it('unknown teams to entry are only excluded from writes (404), not deleted', async () => {
    const res = await cli.put('/api/score/manual', {
      body: { year: YEAR, team_num: 99, score_type: 'report', value: 5 }, cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });
});

describe('Cold-start without entry (503 semantics)', () => {
  let srv, cli, database, dp;

  before(async () => {
    process.env.ENTRY_SERVER = 'http://127.0.0.1:1'; // 연결 불가
    dp = tmpDbPath();
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true, validateUser: TRUST_JWT });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    cli = createClient(started.baseUrl);
  });

  after(async () => {
    await stopServer(srv);
    database.close();
    cleanup(dp);
  });

  it('score aggregation returns 503 (not 500) when no snapshot was ever loaded', async () => {
    const res = await cli.get(`/api/score?year=${new Date().getFullYear()}`, { cookie: adminCookie });
    assert.equal(res.status, 503);
  });

  it('manual score writes return 503 when no snapshot was ever loaded', async () => {
    const res = await cli.put('/api/score/manual', {
      body: { year: new Date().getFullYear(), team_num: 1, score_type: 'report', value: 1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 503);
  });
});
