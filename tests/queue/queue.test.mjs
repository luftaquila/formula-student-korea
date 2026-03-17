import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('../../queue/index.mjs'));
const express = require('express');
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
import { createQueueApp, INSPECTIONS } from '../../queue/index.mjs';

function createMockEntryServer() {
  const app = express();
  // Return entries for the current year
  app.get('/api/entries', (req, res) => {
    res.json({
      1: { univ: '서울대', team: '팀A' },
      2: { univ: '카이스트', team: '팀B' },
      3: { univ: '연세대', team: '팀C' },
    });
  });
  return app;
}

setupTestEnv();

let server, baseUrl, client, db, dbPath;
let mockEntryServer, mockEntryUrl;
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

before(async () => {
  // Start mock entry server first
  const mockApp = createMockEntryServer();
  const mockStarted = await startServer(mockApp);
  mockEntryServer = mockStarted.server;
  mockEntryUrl = mockStarted.baseUrl;
  process.env.ENTRY_SERVER = mockEntryUrl;

  // Then start queue service
  dbPath = tmpDbPath();
  const result = createQueueApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  await stopServer(mockEntryServer);
  db.close();
  cleanup(dbPath);
  // Force exit: logger's setInterval keeps the process alive
  setTimeout(() => process.exit(0), 100).unref();
});

// ─── INSPECTIONS export ─────────────────────────────────────────────────
describe('INSPECTIONS export', () => {
  it('contains 8 inspection types', () => {
    assert.equal(Object.keys(INSPECTIONS).length, 8);
    assert.ok(INSPECTIONS.battery);
    assert.ok(INSPECTIONS.electric);
    assert.ok(INSPECTIONS.chassis);
    assert.ok(INSPECTIONS.tilting);
    assert.ok(INSPECTIONS.braking);
    assert.ok(INSPECTIONS.noise);
    assert.ok(INSPECTIONS.rain);
    assert.ok(INSPECTIONS.report);
  });
});

// ─── Public endpoints ───────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});

describe('GET /api/active', () => {
  it('returns active inspections (all 8 active by default)', async () => {
    const res = await client.get('/api/active');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 8);
  });

  it('does not require auth (public)', async () => {
    const res = await client.get('/api/active');
    assert.equal(res.status, 200);
  });
});

describe('GET /api/booths/all', () => {
  it('returns all booth states', async () => {
    const res = await client.get('/api/booths/all');
    assert.equal(res.status, 200);
    const data = await res.json();
    for (const type of Object.keys(INSPECTIONS)) {
      assert.ok(Array.isArray(data[type]), `expected array for ${type}`);
      assert.equal(data[type].length, 1); // 1 booth per type by default
    }
  });
});

describe('GET /api/booths/:type', () => {
  it('returns booths for specific type', async () => {
    const res = await client.get('/api/booths/battery');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].booth_num, 1);
    assert.equal(data[0].active, 1);
    assert.equal(data[0].occupied_by, null);
  });

  it('rejects invalid type', async () => {
    const res = await client.get('/api/booths/invalid');
    assert.equal(res.status, 400);
  });
});

describe('POST /api/state/:num', () => {
  // First register an entry so we can test state
  it('returns queue state for non-registered entry (no phone check needed)', async () => {
    const res = await client.post('/api/state/1', {
      body: { phone: '01012345678' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Not registered, so queue is undefined
    assert.equal(data.queue, undefined);
    assert.equal(data.rank, -1);
  });

  it('rejects invalid phone format', async () => {
    // Register entry 1 to battery first so phone check triggers
    await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    const res = await client.post('/api/state/1', {
      body: { phone: '010-invalid' },
    });
    assert.equal(res.status, 400);
    // Cancel to clean up
    await client.post('/api/admin/cancel/battery', {
      body: { num: 1 },
      cookie: officialCookie,
    });
    // Wait for penalty to expire by removing it directly
    db.prepare("DELETE FROM cancel_penalty WHERE num = 1").run();
  });

  it('rejects non-existent entry', async () => {
    const res = await client.post('/api/state/999', {
      body: { phone: '01012345678' },
    });
    assert.equal(res.status, 400);
  });
});

// ─── Auth enforcement ───────────────────────────────────────────────────
describe('Auth enforcement', () => {
  it('POST /api/admin/register/:type without auth returns 401', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/active without auth returns 200 (public)', async () => {
    const res = await client.get('/api/active');
    assert.equal(res.status, 200);
  });
});

// ─── Inspection management ──────────────────────────────────────────────
describe('GET /api/admin/all', () => {
  it('returns all 8 inspection types', async () => {
    const res = await client.get('/api/admin/all', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 8);
    const types = data.map(d => d.type);
    for (const type of Object.keys(INSPECTIONS)) {
      assert.ok(types.includes(type));
    }
  });
});

describe('GET /api/admin/inspection/:type', () => {
  it('returns empty queue', async () => {
    const res = await client.get('/api/admin/inspection/battery', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });
});

describe('PATCH /api/admin/inspection/:type', () => {
  it('toggles active state to false', async () => {
    const res = await client.patch('/api/admin/inspection/rain', {
      body: { active: false },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    // Verify
    const active = await client.get('/api/active');
    const data = await active.json();
    assert.equal(data.length, 7);
    assert.ok(!data.some(d => d.type === 'rain'));
  });

  it('toggles active state back to true', async () => {
    const res = await client.patch('/api/admin/inspection/rain', {
      body: { active: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const active = await client.get('/api/active');
    const data = await active.json();
    assert.equal(data.length, 8);
  });
});

describe('PATCH /api/admin/inspection/:type/visibility', () => {
  it('toggles hidden_from_register', async () => {
    const res = await client.patch('/api/admin/inspection/rain/visibility', {
      body: { hidden: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    // Verify via all inspections
    const all = await client.get('/api/admin/all', { cookie: officialCookie });
    const data = await all.json();
    const rain = data.find(d => d.type === 'rain');
    assert.equal(rain.hidden_from_register, 1);
  });

  it('toggles hidden_from_register back to false', async () => {
    const res = await client.patch('/api/admin/inspection/rain/visibility', {
      body: { hidden: false },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const all = await client.get('/api/admin/all', { cookie: officialCookie });
    const data = await all.json();
    const rain = data.find(d => d.type === 'rain');
    assert.equal(rain.hidden_from_register, 0);
  });
});

// ─── Queue registration ─────────────────────────────────────────────────
describe('POST /api/admin/register/:type', () => {
  it('registers entry to queue', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 201);
    // Verify queue
    const queue = await client.get('/api/admin/inspection/battery', { cookie: officialCookie });
    const data = await queue.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].num, 1);
  });

  it('rejects duplicate registration', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('allows report + other inspection simultaneously', async () => {
    const res = await client.post('/api/admin/register/report', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 201);
  });

  it('allows battery + chassis simultaneously', async () => {
    const res = await client.post('/api/admin/register/chassis', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 201);
  });

  it('rejects other incompatible combinations', async () => {
    // Entry 1 has battery + report + chassis, try to add electric
    const res = await client.post('/api/admin/register/electric', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects inactive inspection', async () => {
    // Deactivate rain
    await client.patch('/api/admin/inspection/rain', {
      body: { active: false },
      cookie: chiefCookie,
    });
    const res = await client.post('/api/admin/register/rain', {
      body: { num: 2, phone: '01098765432' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
    // Re-activate
    await client.patch('/api/admin/inspection/rain', {
      body: { active: true },
      cookie: chiefCookie,
    });
  });

  it('rejects non-existent entry', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 999, phone: '01099999999' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('applies cancel penalty (register after cancel)', async () => {
    // Register entry 2 to electric
    await client.post('/api/admin/register/electric', {
      body: { num: 2, phone: '01098765432' },
      cookie: officialCookie,
    });
    // Cancel it (applies penalty)
    await client.post('/api/admin/cancel/electric', {
      body: { num: 2 },
      cookie: officialCookie,
    });
    // Try to re-register immediately - should be 403 (penalty)
    const res = await client.post('/api/admin/register/electric', {
      body: { num: 2, phone: '01098765432' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
    // Clean up penalty for future tests
    db.prepare("DELETE FROM cancel_penalty WHERE num = 2").run();
  });
});

// ─── Queue cancellation ─────────────────────────────────────────────────
describe('POST /api/admin/cancel/:type', () => {
  it('cancels entry from queue', async () => {
    // Cancel entry 1 from report queue
    const res = await client.post('/api/admin/cancel/report', {
      body: { num: 1 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    // Verify report queue is empty
    const queue = await client.get('/api/admin/inspection/report', { cookie: officialCookie });
    const data = await queue.json();
    assert.ok(!data.some(d => d.num === 1));
  });

  it('applies penalty on cancel', async () => {
    // Entry 1 should have cancel penalty on report now
    const penalty = db.prepare("SELECT * FROM cancel_penalty WHERE num = 1 AND inspection = 'report'").get();
    assert.ok(penalty);
    assert.ok(penalty.until > Date.now());
    // Clean up
    db.prepare("DELETE FROM cancel_penalty WHERE num = 1 AND inspection = 'report'").run();
  });

  it('handles current table (removes inspection from comma-separated list)', async () => {
    // Entry 1 currently has battery,chassis (report was cancelled)
    const current = db.prepare("SELECT * FROM current WHERE num = 1").get();
    assert.ok(current);
    const types = current.inspection.split(',');
    assert.ok(!types.includes('report'));
    assert.ok(types.includes('battery'));
    assert.ok(types.includes('chassis'));
  });

  it('rejects non-existent entry in queue', async () => {
    const res = await client.post('/api/admin/cancel/electric', {
      body: { num: 3 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Priority management ────────────────────────────────────────────────
describe('Priority management', () => {
  it('GET /api/admin/priority/:type returns empty initially', async () => {
    const res = await client.get('/api/admin/priority/battery', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/admin/priority/:type sets priority', async () => {
    const res = await client.post('/api/admin/priority/battery', {
      body: { num: 1, priority: 1 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
    // Verify
    const list = await client.get('/api/admin/priority/battery', { cookie: chiefCookie });
    const data = await list.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].num, 1);
    assert.equal(data[0].priority, 1);
  });

  it('DELETE /api/admin/priority/:type removes priority', async () => {
    const res = await client.delete('/api/admin/priority/battery', {
      body: { num: 1 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const list = await client.get('/api/admin/priority/battery', { cookie: chiefCookie });
    const data = await list.json();
    assert.equal(data.length, 0);
  });

  it('DELETE /api/admin/priority/:type/all clears all priorities', async () => {
    // Add multiple priorities
    await client.post('/api/admin/priority/battery', {
      body: { num: 1, priority: 1 },
      cookie: chiefCookie,
    });
    await client.post('/api/admin/priority/battery', {
      body: { num: 2, priority: 2 },
      cookie: chiefCookie,
    });
    const res = await client.delete('/api/admin/priority/battery/all', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const list = await client.get('/api/admin/priority/battery', { cookie: chiefCookie });
    const data = await list.json();
    assert.equal(data.length, 0);
  });
});

// ─── Ignore settings ────────────────────────────────────────────────────
describe('PUT /api/admin/inspection/:type/ignore', () => {
  it('sets ignore_priority', async () => {
    const res = await client.put('/api/admin/inspection/battery/ignore', {
      body: { field: 'ignore_priority', value: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const all = await client.get('/api/admin/all', { cookie: officialCookie });
    const data = await all.json();
    const battery = data.find(d => d.type === 'battery');
    assert.equal(battery.ignore_priority, 1);
    // Reset
    await client.put('/api/admin/inspection/battery/ignore', {
      body: { field: 'ignore_priority', value: false },
      cookie: chiefCookie,
    });
  });

  it('sets ignore_reinspection', async () => {
    const res = await client.put('/api/admin/inspection/battery/ignore', {
      body: { field: 'ignore_reinspection', value: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const all = await client.get('/api/admin/all', { cookie: officialCookie });
    const data = await all.json();
    const battery = data.find(d => d.type === 'battery');
    assert.equal(battery.ignore_reinspection, 1);
    // Reset
    await client.put('/api/admin/inspection/battery/ignore', {
      body: { field: 'ignore_reinspection', value: false },
      cookie: chiefCookie,
    });
  });

  it('rejects invalid field', async () => {
    const res = await client.put('/api/admin/inspection/battery/ignore', {
      body: { field: 'invalid_field', value: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Booth management ───────────────────────────────────────────────────
describe('Booth management', () => {
  it('GET /api/admin/booths/:type returns booth list', async () => {
    const res = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
  });

  it('PATCH /api/admin/booths/:type/config increases booth count', async () => {
    const res = await client.patch('/api/admin/booths/battery/config', {
      body: { count: 3 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const booths = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    const data = await booths.json();
    assert.equal(data.length, 3);
  });

  it('PATCH /api/admin/booths/:type/:boothNum toggles booth active', async () => {
    const res = await client.patch('/api/admin/booths/battery/2', {
      body: { active: false },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const booths = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    const data = await booths.json();
    const booth2 = data.find(b => b.booth_num === 2);
    assert.equal(booth2.active, 0);
    // Re-activate
    await client.patch('/api/admin/booths/battery/2', {
      body: { active: true },
      cookie: officialCookie,
    });
  });

  it('POST /api/admin/booths/:type/:boothNum/enter moves entry from queue to booth', async () => {
    // Entry 1 is in battery queue from registration tests
    const res = await client.post('/api/admin/booths/battery/1/enter', {
      body: { num: 1 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    // Verify booth is occupied
    const booths = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    const data = await booths.json();
    const booth1 = data.find(b => b.booth_num === 1);
    assert.equal(booth1.occupied_by, 1);
    // Verify queue is empty
    const queue = await client.get('/api/admin/inspection/battery', { cookie: officialCookie });
    const qData = await queue.json();
    assert.ok(!qData.some(d => d.num === 1));
  });

  it('POST /api/admin/booths/:type/:boothNum/enter rejects if entry not in queue', async () => {
    const res = await client.post('/api/admin/booths/battery/2/enter', {
      body: { num: 3 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/booths/:type/:boothNum/enter rejects if booth occupied', async () => {
    // Register entry 2 to battery first
    await client.post('/api/admin/register/battery', {
      body: { num: 2, phone: '01098765432' },
      cookie: officialCookie,
    });
    // Try to enter booth 1 which is occupied by entry 1
    const res = await client.post('/api/admin/booths/battery/1/enter', {
      body: { num: 2 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/admin/booths/:type/:boothNum rejects deactivating occupied booth', async () => {
    // Booth 1 is occupied by entry 1
    const res = await client.patch('/api/admin/booths/battery/1', {
      body: { active: false },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/admin/booths/:type/config rejects decreasing when booth occupied', async () => {
    // We have 3 booths, booth 1 occupied. Try to reduce to 1 - booth 3 isn't occupied
    // but going from 3 to 1 would try to remove booths 3 and 2, booth 2 is not occupied
    // Actually booth 1 is occupied but it's the lowest. Removing highest first: 3, 2 (not occupied).
    // Let's occupy booth 3 to make this fail
    // Entry 2 is in battery queue, enter it to booth 3
    await client.post('/api/admin/booths/battery/3/enter', {
      body: { num: 2 },
      cookie: officialCookie,
    });
    // Now try to decrease from 3 to 1 - would remove booth 3 (occupied) first
    const res = await client.patch('/api/admin/booths/battery/config', {
      body: { count: 1 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/booths/:type/:boothNum/exit completes inspection', async () => {
    const res = await client.post('/api/admin/booths/battery/1/exit', {
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    // Verify booth is empty
    const booths = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    const data = await booths.json();
    const booth1 = data.find(b => b.booth_num === 1);
    assert.equal(booth1.occupied_by, null);
  });

  it('POST /api/admin/booths/:type/:boothNum/exit rejects if booth empty', async () => {
    const res = await client.post('/api/admin/booths/battery/1/exit', {
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/booths/:type/:boothNum/exit records history', async () => {
    // Entry 1 should have inspection_history record from the exit above
    const history = db.prepare("SELECT * FROM inspection_history WHERE num = 1 AND inspection = 'battery'").all();
    assert.ok(history.length > 0);
  });

  // Clean up: exit entry 2 from booth 3
  it('cleanup: exit entry 2 from booth 3', async () => {
    const res = await client.post('/api/admin/booths/battery/3/exit', {
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });
});

// ─── History ────────────────────────────────────────────────────────────
describe('DELETE /api/admin/history/:type', () => {
  it('clears history and resets booths', async () => {
    const res = await client.delete('/api/admin/history/battery', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    // Verify history is cleared
    const history = db.prepare("SELECT * FROM inspection_history WHERE inspection = 'battery'").all();
    assert.equal(history.length, 0);
    // Verify booths are reset (occupied_by = null)
    const booths = await client.get('/api/admin/booths/battery', { cookie: officialCookie });
    const data = await booths.json();
    for (const booth of data) {
      assert.equal(booth.occupied_by, null);
    }
  });
});

// ─── Statistics ─────────────────────────────────────────────────────────
describe('Statistics', () => {
  it('GET /api/admin/stats/timerange returns time range', async () => {
    const res = await client.get('/api/admin/stats/timerange', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok('from' in data);
    assert.ok('to' in data);
  });

  it('GET /api/admin/stats returns stats with accurate counts', async () => {
    const res = await client.get('/api/admin/stats', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);

    // Verify aggregate stats reflect actual operations
    // Entry 1: registered multiple times across tests, cancelled, re-registered, entered booth, exited
    const entry1 = data.find(d => d.num === 1);
    assert.ok(entry1, 'entry 1 should have stats');
    assert.ok(entry1.registrations >= 1, 'entry 1 should have registrations');
    assert.ok(entry1.entries >= 1, 'entry 1 should have booth entries');
    assert.ok(entry1.totalOccupyTime >= 0, 'totalOccupyTime should be non-negative');
  });

  it('GET /api/admin/stats filters by inspection type', async () => {
    const res = await client.get('/api/admin/stats?inspection=battery', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    // Should only include stats from battery inspection
    for (const entry of data) {
      assert.ok(entry.registrations >= 0);
    }
  });

  it('GET /api/admin/stats/:num returns team timeline with event details', async () => {
    const res = await client.get('/api/admin/stats/1', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.summary);
    assert.ok(Array.isArray(data.timeline));
    assert.ok(data.summary.registrations >= 1, 'should have registrations');

    // Timeline should contain register, cancel, enter, exit events
    const eventTypes = data.timeline.map(e => e.event);
    assert.ok(eventTypes.includes('register'), 'timeline should include register events');

    // Each timeline event should have inspection and timestamp
    for (const event of data.timeline) {
      assert.ok(event.timestamp, 'each timeline event should have timestamp');
      assert.ok(event.inspection, 'each timeline event should have inspection type');
    }
  });

  it('GET /api/admin/stats/:num filters by time range', async () => {
    // Get the overall time range first
    const rangeRes = await client.get('/api/admin/stats/timerange', { cookie: officialCookie });
    const range = await rangeRes.json();

    if (range.from && range.to) {
      // Query with a narrow time range
      const res = await client.get(`/api/admin/stats/1?from=${range.from}&to=${range.to}`, { cookie: officialCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.summary);
      assert.ok(data.summary.registrations >= 0);
    }
  });
});

// ─── Settings ───────────────────────────────────────────────────────────
describe('SMS settings', () => {
  it('GET /api/admin/settings/sms returns SMS status (FALSE)', async () => {
    const res = await client.get('/api/admin/settings/sms', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.value, false);
  });

  it('PATCH /api/admin/settings/sms rejects enable without env vars', async () => {
    const res = await client.patch('/api/admin/settings/sms', {
      body: { value: true },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('SMS rank settings', () => {
  it('GET /api/admin/settings/sms-rank returns rank (default 3)', async () => {
    const res = await client.get('/api/admin/settings/sms-rank', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.value, 3);
  });

  it('PATCH /api/admin/settings/sms-rank updates rank', async () => {
    const res = await client.patch('/api/admin/settings/sms-rank', {
      body: { value: 5 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const check = await client.get('/api/admin/settings/sms-rank', { cookie: officialCookie });
    const data = await check.json();
    assert.equal(data.value, 5);
    // Reset
    await client.patch('/api/admin/settings/sms-rank', {
      body: { value: 3 },
      cookie: chiefCookie,
    });
  });

  it('PATCH /api/admin/settings/sms-rank rejects out of range', async () => {
    const res = await client.patch('/api/admin/settings/sms-rank', {
      body: { value: 11 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
    const res2 = await client.patch('/api/admin/settings/sms-rank', {
      body: { value: 0 },
      cookie: chiefCookie,
    });
    assert.equal(res2.status, 400);
  });
});

describe('Cancel penalty settings', () => {
  it('GET /api/admin/settings/cancel-penalty returns penalty (default 10)', async () => {
    const res = await client.get('/api/admin/settings/cancel-penalty', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.value, 10);
  });

  it('PATCH /api/admin/settings/cancel-penalty updates penalty', async () => {
    const res = await client.patch('/api/admin/settings/cancel-penalty', {
      body: { value: 5 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const check = await client.get('/api/admin/settings/cancel-penalty', { cookie: officialCookie });
    const data = await check.json();
    assert.equal(data.value, 5);
    // Reset
    await client.patch('/api/admin/settings/cancel-penalty', {
      body: { value: 10 },
      cookie: chiefCookie,
    });
  });

  it('PATCH /api/admin/settings/cancel-penalty rejects out of range', async () => {
    const res = await client.patch('/api/admin/settings/cancel-penalty', {
      body: { value: 61 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
    const res2 = await client.patch('/api/admin/settings/cancel-penalty', {
      body: { value: -1 },
      cookie: chiefCookie,
    });
    assert.equal(res2.status, 400);
  });
});

// ─── Queue sorting ──────────────────────────────────────────────────────
describe('Queue sorting', () => {
  // Clean up remaining state from previous tests
  before(async () => {
    // Clean up: cancel all entries in all queues, reset penalties
    for (const type of Object.keys(INSPECTIONS)) {
      const queue = db.prepare(`SELECT num FROM '${type}'`).all();
      for (const entry of queue) {
        await client.post(`/api/admin/cancel/${type}`, {
          body: { num: entry.num },
          cookie: officialCookie,
        });
      }
    }
    db.prepare("DELETE FROM cancel_penalty").run();
    db.prepare("DELETE FROM current").run();
    // Keep history for entry 2 (it has inspection_history from booth exit)
    // Entry 1's history was cleared in the DELETE /api/admin/history test
  });

  it('sorts queue: first inspection > reinspection, higher priority > lower, FIFO', async () => {
    // Entry 2 has battery history (reinspection)
    // Entry 1 has no battery history (first inspection, was cleared)
    // Entry 3 has no battery history (first inspection)

    // Register entry 2 first (reinspection because of history)
    await client.post('/api/admin/register/battery', {
      body: { num: 2, phone: '01098765432' },
      cookie: officialCookie,
    });

    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));

    // Register entry 3 (first inspection)
    await client.post('/api/admin/register/battery', {
      body: { num: 3, phone: '01011112222' },
      cookie: officialCookie,
    });

    await new Promise(r => setTimeout(r, 10));

    // Register entry 1 (first inspection, registered after entry 3)
    await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });

    // Set priority: entry 1 = priority 2, entry 3 = priority 1
    await client.post('/api/admin/priority/battery', {
      body: { num: 1, priority: 2 },
      cookie: chiefCookie,
    });
    await client.post('/api/admin/priority/battery', {
      body: { num: 3, priority: 1 },
      cookie: chiefCookie,
    });

    // Expected order:
    // 1. First inspections sorted by priority then FIFO:
    //    - Entry 3 (first inspection, priority 1)
    //    - Entry 1 (first inspection, priority 2)
    // 2. Reinspections sorted by priority then FIFO:
    //    - Entry 2 (reinspection, priority 999/default)
    const queue = await client.get('/api/admin/inspection/battery', { cookie: officialCookie });
    const data = await queue.json();
    assert.equal(data.length, 3);
    assert.equal(data[0].num, 3, 'first should be entry 3 (first inspection, priority 1)');
    assert.equal(data[1].num, 1, 'second should be entry 1 (first inspection, priority 2)');
    assert.equal(data[2].num, 2, 'third should be entry 2 (reinspection)');
  });
});

// ─── Queue sorting with ignore flags ────────────────────────────────────
describe('Queue sorting with ignore flags', () => {
  // Use a different inspection type than the main sorting test to avoid interference
  const testType = 'noise';

  before(async () => {
    // Clear ALL state: booths, queues, current, penalties
    for (const type of Object.keys(INSPECTIONS)) {
      // Clear booths first
      const booths = db.prepare("SELECT booth_num, occupied_by FROM booth WHERE inspection = ?").all(type);
      for (const b of booths) {
        if (b.occupied_by !== null) {
          db.prepare("UPDATE booth SET occupied_by = NULL, entered_at = NULL WHERE inspection = ? AND booth_num = ?").run(type, b.booth_num);
        }
      }
      // Clear queue tables
      db.prepare(`DELETE FROM '${type}'`).run();
      // Reset inspection length
      db.prepare("UPDATE inspection SET length = 0 WHERE type = ?").run(type);
    }
    db.prepare("DELETE FROM cancel_penalty").run();
    db.prepare("DELETE FROM current").run();

    // Ensure the inspection type is active
    await client.patch(`/api/admin/inspection/${testType}`, {
      cookie: chiefCookie,
      body: { active: true },
    });
    // Reset ignore flags
    await client.put(`/api/admin/inspection/${testType}/ignore`, {
      cookie: chiefCookie,
      body: { field: 'ignore_priority', value: false },
    });
    await client.put(`/api/admin/inspection/${testType}/ignore`, {
      cookie: chiefCookie,
      body: { field: 'ignore_reinspection', value: false },
    });
    db.prepare(`DELETE FROM team_priority WHERE inspection = ?`).run(testType);
    db.prepare(`DELETE FROM inspection_history WHERE inspection = ?`).run(testType);
  });

  it('ignore_priority makes priority not affect order', async () => {
    // Register entry 1 (no priority = default 999)
    await client.post(`/api/admin/register/${testType}`, {
      cookie: officialCookie,
      body: { num: 1, phone: '01011111111' },
    });

    await new Promise(r => setTimeout(r, 10));

    // Register entry 2 with high priority
    await client.post(`/api/admin/priority/${testType}`, {
      cookie: chiefCookie,
      body: { num: 2, priority: 1 },
    });
    await client.post(`/api/admin/register/${testType}`, {
      cookie: officialCookie,
      body: { num: 2, phone: '01022222222' },
    });

    // Default: entry 2 (priority 1) should be before entry 1 (priority 999)
    let queue = await client.get(`/api/admin/inspection/${testType}`, { cookie: officialCookie });
    let data = await queue.json();
    assert.equal(data[0].num, 2, 'higher priority should be first by default');

    // Enable ignore_priority
    await client.put(`/api/admin/inspection/${testType}/ignore`, {
      cookie: chiefCookie,
      body: { field: 'ignore_priority', value: true },
    });

    // Now should be FIFO: entry 1 first (registered first)
    queue = await client.get(`/api/admin/inspection/${testType}`, { cookie: officialCookie });
    data = await queue.json();
    assert.equal(data[0].num, 1, 'with ignore_priority, FIFO should determine order');

    // Cleanup
    await client.post(`/api/admin/cancel/${testType}`, { cookie: officialCookie, body: { num: 1 } });
    await client.post(`/api/admin/cancel/${testType}`, { cookie: officialCookie, body: { num: 2 } });
    db.prepare(`DELETE FROM cancel_penalty WHERE inspection = ?`).run(testType);
    db.prepare(`DELETE FROM team_priority WHERE inspection = ?`).run(testType);
    await client.put(`/api/admin/inspection/${testType}/ignore`, {
      cookie: chiefCookie,
      body: { field: 'ignore_priority', value: false },
    });
  });

  it('ignore_reinspection makes reinspection status not affect order', async () => {
    // Create reinspection history for entry 1
    // First do a full cycle: register -> enter booth -> exit booth (records history)
    await client.post(`/api/admin/register/${testType}`, {
      cookie: officialCookie,
      body: { num: 1, phone: '01011111111' },
    });
    await client.post(`/api/admin/booths/${testType}/1/enter`, {
      cookie: officialCookie,
      body: { num: 1 },
    });
    await client.post(`/api/admin/booths/${testType}/1/exit`, {
      cookie: officialCookie,
    });

    // Now register both: entry 1 is reinspection, entry 2 is first
    await client.post(`/api/admin/register/${testType}`, {
      cookie: officialCookie,
      body: { num: 1, phone: '01011111111' },
    });

    await new Promise(r => setTimeout(r, 10));

    await client.post(`/api/admin/register/${testType}`, {
      cookie: officialCookie,
      body: { num: 2, phone: '01022222222' },
    });

    // Default: entry 2 (first inspection) should be before entry 1 (reinspection)
    let queue = await client.get(`/api/admin/inspection/${testType}`, { cookie: officialCookie });
    let data = await queue.json();
    assert.equal(data[0].num, 2, 'first inspection should come before reinspection by default');

    // Enable ignore_reinspection
    await client.put(`/api/admin/inspection/${testType}/ignore`, {
      cookie: chiefCookie,
      body: { field: 'ignore_reinspection', value: true },
    });

    // Now should be FIFO: entry 1 first (registered first)
    queue = await client.get(`/api/admin/inspection/${testType}`, { cookie: officialCookie });
    data = await queue.json();
    assert.equal(data[0].num, 1, 'with ignore_reinspection, FIFO should determine order');

    // Cleanup
    await client.post(`/api/admin/cancel/${testType}`, { cookie: officialCookie, body: { num: 1 } });
    await client.post(`/api/admin/cancel/${testType}`, { cookie: officialCookie, body: { num: 2 } });
    db.prepare(`DELETE FROM cancel_penalty WHERE inspection = ?`).run(testType);
  });
});

// ─── Logs endpoint ──────────────────────────────────────────────────────
describe('GET /api/logs', () => {
  it('requires admin role (official gets 403)', async () => {
    const res = await client.get('/api/logs', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });

  it('returns logs for admin', async () => {
    const res = await client.get('/api/logs', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.logs));
    assert.equal(data.service, 'queue');
    assert.equal(typeof data.total, 'number');
  });
});

// ─── SSE endpoint ───────────────────────────────────────────────────────
describe('GET /api/events', () => {
  it('returns SSE stream (public)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    controller.abort();
  });
});

// ─── Additional edge cases ──────────────────────────────────────────────
describe('Validation edge cases', () => {
  it('rejects invalid entry number in register', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: -1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing phone in register', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid inspection type', async () => {
    const res = await client.post('/api/admin/register/nonexistent', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid priority value', async () => {
    const res = await client.post('/api/admin/priority/battery', {
      body: { num: 1, priority: -1 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects deleting non-existent priority', async () => {
    const res = await client.delete('/api/admin/priority/electric', {
      body: { num: 99 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── POST /api/state with registered entry ──────────────────────────────
describe('POST /api/state/:num (with registered entry)', () => {
  before(async () => {
    // Ensure entry 1 is registered in battery (may have been cleared by earlier tests)
    const queue = await client.get('/api/admin/inspection/battery', { cookie: officialCookie });
    const data = await queue.json();
    if (!data.some(d => d.num === 1)) {
      // Clear current entry if needed
      const current = db.prepare("SELECT * FROM current WHERE num = 1").get();
      if (current) {
        for (const type of current.inspection.split(',')) {
          await client.post(`/api/admin/cancel/${type}`, { body: { num: 1 }, cookie: officialCookie });
        }
        db.prepare("DELETE FROM cancel_penalty WHERE num = 1").run();
      }
      await client.post('/api/admin/register/battery', {
        body: { num: 1, phone: '01012345678' },
        cookie: officialCookie,
      });
    }
  });

  it('returns queue rank when phone matches', async () => {
    const res = await client.post('/api/state/1', {
      body: { phone: '01012345678' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.queue);
    assert.ok(data.rank);
  });

  it('rejects mismatched phone', async () => {
    const res = await client.post('/api/state/1', {
      body: { phone: '01099999999' },
    });
    assert.equal(res.status, 400);
  });

  it('returns comma-separated queue names and ranks for multi-registered entry', async () => {
    // Clean up entry 3 state
    db.prepare("DELETE FROM current WHERE num = 3").run();
    db.prepare("DELETE FROM cancel_penalty WHERE num = 3").run();

    // Register entry 3 in both battery and report (report is always compatible)
    await client.post('/api/admin/register/battery', {
      cookie: officialCookie,
      body: { num: 3, phone: '01033333333' },
    });
    await client.post('/api/admin/register/report', {
      cookie: officialCookie,
      body: { num: 3, phone: '01033333333' },
    });

    const res = await client.post('/api/state/3', {
      body: { phone: '01033333333' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Should have comma-separated queue and rank
    assert.ok(data.queue.includes(','), 'queue should be comma-separated for multiple inspections');
    assert.ok(String(data.rank).includes(','), 'rank should be comma-separated');
  });
});

// ─── Public endpoint rate limiting ───────────────────────────────────────
// NOTE: This must be the LAST test block because it exhausts the rate limit
// for /api/state/:num, which would cause subsequent tests using that endpoint to get 429.
describe('Public endpoint rate limiting', () => {
  it('returns 429 after 30 requests to /api/state/:num', async () => {
    let lastStatus;
    for (let i = 0; i < 35; i++) {
      const res = await client.post('/api/state/1', { body: { phone: '01011111111' } });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    assert.equal(lastStatus, 429, 'should rate limit after 30 requests');
  });
});
