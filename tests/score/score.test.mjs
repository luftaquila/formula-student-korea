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
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';
import { createScoreApp } from '../../score/index.mjs';

// ─── Mock Servers ───────────────────────────────────────────────────────

function createMockEntryServer() {
  const app = express();
  app.get('/api/entries', (req, res) => {
    res.json({
      1: { univ: '서울대', team: '팀A', type: 'EV' },
      2: { univ: '카이스트', team: '팀B', type: 'EV' },
    });
  });
  return app;
}

function createMockInspectionServer() {
  const app = express();
  app.get('/api/sheet/summary', (req, res) => {
    res.json({
      categories: [{ id: 1, name: '코너웨이트' }],
      teams: {}
    });
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
  const result = createScoreApp({ dbPath, skipSSESubscriptions: true });
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
  it('upserts a manual score', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 85 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('upserts again (update existing)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 90 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
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

  it('allows null value (clears score)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 2, score_type: 'energy', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
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

  it('updates status field to DNF', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNF' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('validates status value DNS', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNS' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('validates status value DSQ', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 2, field: 'status', value: 'DSQ' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('allows null status (clear)', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 2, field: 'status', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
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

  it('returns aggregated data with entries, inspection, events, manualScores, penalties, settings', async () => {
    const year = new Date().getFullYear();
    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.entries);
    assert.ok(data.inspection);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.manualScores);
    assert.ok(data.penalties);
    assert.ok(data.settings);
  });

  it('entries come from mock entry server', async () => {
    const year = new Date().getFullYear();
    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    const data = await res.json();
    assert.equal(data.entries['1'].univ, '서울대');
    assert.equal(data.entries['2'].univ, '카이스트');
  });

  it('events include records from mock traffic server', async () => {
    const year = new Date().getFullYear();
    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    const data = await res.json();
    const accelEvent = data.events.find(e => e.type === '가속');
    assert.ok(accelEvent, 'should have 가속 event');
    assert.ok(accelEvent.records, 'should have records');
    // Team 1 should have records (two runs)
    assert.ok(accelEvent.records['1'], 'team 1 should have records');
    // Team 2 should have records (one run)
    assert.ok(accelEvent.records['2'], 'team 2 should have records');
  });

  it('manualScores include previously set manual scores', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    // Team 1 report was overwritten to 90
    assert.equal(data.manualScores['1'].report, 90);
    // Team 2 energy was set to null
    assert.equal(data.manualScores['2'].report, 70);
  });

  it('penalties include previously set penalty config', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    assert.ok(data.penalties['가속']);
    assert.equal(data.penalties['가속'].cone_penalty, 2);
    assert.equal(data.penalties['가속'].oc_penalty, 10);
    assert.equal(data.penalties['가속'].start_delay, 5);
  });

  it('settings include previously set score settings', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    assert.ok(data.settings['가속']);
    assert.equal(data.settings['가속'].total_score, 75);
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

  it('endurance data included in events', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    const enduranceEvent = data.events.find(e => e.type === '내구');
    assert.ok(enduranceEvent, 'should have 내구 event');
    assert.ok(enduranceEvent.records, 'should have records');
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

// ─── Auth ───────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('PUT /api/score/manual without auth returns 401', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 50 },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/health without auth returns 200', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
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

    const res = await client.get('/api/score/public/2026');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.year, 2026);
    assert.deepEqual(Object.keys(data).sort(), ['entries', 'events', 'year']);
    assert.deepEqual(data.entries['1'], { univ: '서울대', team: '팀A', type: 'EV' });
    assert.equal(data.events.some((event) => event.type === '내구'), false);
    assert.ok(data.events.some((event) => event.type === '가속'));
    assert.deepEqual(Object.keys(data.events.find((event) => event.type === '가속').records['1']), ['result']);
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
    await reader.cancel();
    controller.abort();
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
    // Rich entry mock with 3 teams
    const richEntryApp = express();
    richEntryApp.get('/api/entries', (req, res) => {
      res.json({
        1: { univ: '서울대', team: '팀A', type: 'EV' },
        2: { univ: '카이스트', team: '팀B', type: 'EV' },
        3: { univ: '연세대', team: '팀C', type: 'EV' },
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
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true });
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
    entryApp.get('/api/entries', (req, res) => {
      res.json({ 1: { univ: 'A대', team: '팀A', type: 'EV' } });
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
    const result = createScoreApp({ dbPath: dp, skipSSESubscriptions: true });
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

// ─── Internal API: entry lifecycle ──────────────────────────────────────
describe('Score internal entry lifecycle sync', () => {
  it('renumbers and deletes manual/endurance rows', async () => {
    const year = 2026;
    db.prepare("INSERT OR REPLACE INTO score_manual (year, team_num, score_type, value) VALUES (?, ?, ?, ?)")
      .run(year, 901, 'report', 12.5);
    db.prepare("INSERT OR REPLACE INTO score_endurance (year, team_num, status, driver1_time) VALUES (?, ?, ?, ?)")
      .run(year, 901, 'DNF', 12345);

    const patchRes = await client.patch('/api/internal/team-num', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { year, prevNum: 901, newNum: 902 },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_manual WHERE year = ? AND team_num = ?").get(year, 902).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_endurance WHERE year = ? AND team_num = ?").get(year, 902).c, 1);

    const deleteRes = await client.delete(`/api/internal/team/902?year=${year}`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(deleteRes.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_manual WHERE year = ? AND team_num = ?").get(year, 902).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_endurance WHERE year = ? AND team_num = ?").get(year, 902).c, 0);
  });

  it('treats prevNum === newNum as a no-op and preserves score rows', async () => {
    const year = 2026;
    db.prepare("INSERT OR REPLACE INTO score_manual (year, team_num, score_type, value) VALUES (?, ?, ?, ?)")
      .run(year, 905, 'report', 33.3);
    db.prepare("INSERT OR REPLACE INTO score_endurance (year, team_num, status, driver1_time) VALUES (?, ?, ?, ?)")
      .run(year, 905, 'FINISH', 54321);

    const res = await client.patch('/api/internal/team-num', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { year, prevNum: 905, newNum: 905 },
    });
    assert.equal(res.status, 200);

    // self-renumber는 목적지(=자기 번호) 행을 먼저 삭제하므로, 가드가 없으면 점수가 사라진다.
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_manual WHERE year = ? AND team_num = ?").get(year, 905).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM score_endurance WHERE year = ? AND team_num = ?").get(year, 905).c, 1);
  });
});
