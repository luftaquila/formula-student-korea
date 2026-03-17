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
  app.get('/api/records', (req, res) => {
    const year = new Date().getFullYear();
    res.json([`FSK ${year} 가속 1차`]);
  });
  app.get('/api/records/:name', (req, res) => {
    res.json([
      { rowid: 1, time: '2026-01-01T10:00:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 50000, cones: 0, oc: 0, invalidated: 0, scoreboard: 1 },
      { rowid: 2, time: '2026-01-01T10:05:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 48000, cones: 1, oc: 0, invalidated: 0, scoreboard: 1 },
      { rowid: 3, time: '2026-01-01T10:10:00', num: 2, univ: '카이스트', team: '팀B', type: '가속', result: 52000, cones: 0, oc: 1, invalidated: 0, scoreboard: 1 },
    ]);
  });
  app.get('/api/event-modes', (req, res) => {
    res.json([
      { event_type: '가속', enabled: 1 },
      { event_type: '스키드패드', enabled: 1 },
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
});
