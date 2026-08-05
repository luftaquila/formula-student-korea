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
const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
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
      cookie: chiefCookie,
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

  // Role boundary: student rejected from official-level endpoints
  it('student is rejected from official-level endpoints (403)', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: studentCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level registration endpoint (403)', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  // Role boundary: official rejected from chief-level endpoints
  it('official is rejected from chief-level priority endpoint (403)', async () => {
    const res = await client.post('/api/admin/priority/battery', {
      body: { num: 1 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level inspection toggle (403)', async () => {
    const res = await client.patch('/api/admin/inspection/battery', {
      body: { active: true },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level visibility toggle (403)', async () => {
    const res = await client.patch('/api/admin/inspection/battery/visibility', {
      body: { visible: true },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level booth config (403)', async () => {
    const res = await client.patch('/api/admin/booths/battery/config', {
      body: { count: 3 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level settings (403)', async () => {
    const res = await client.patch('/api/admin/settings/cancel-penalty', {
      body: { minutes: 10 },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level history delete (403)', async () => {
    const res = await client.delete('/api/admin/history/battery', {
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('official is rejected from chief-level ignore setting (403)', async () => {
    const res = await client.put('/api/admin/inspection/battery/ignore', {
      body: { ignore_priority: true },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
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
      cookie: chiefCookie,
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
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('allows report + other inspection simultaneously', async () => {
    const res = await client.post('/api/admin/register/report', {
      body: { num: 1, phone: '01012345678' },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
    const inspections = db.prepare(
      'SELECT inspection FROM current_inspection WHERE num = ? ORDER BY inspection'
    ).all(1).map(row => row.inspection);
    assert.deepEqual(inspections, ['battery', 'report']);
  });

  it('allows battery + chassis simultaneously', async () => {
    const res = await client.post('/api/admin/register/chassis', {
      body: { num: 1, phone: '01012345678' },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
    const inspections = db.prepare(
      'SELECT inspection FROM current_inspection WHERE num = ? ORDER BY inspection'
    ).all(1).map(row => row.inspection);
    assert.deepEqual(inspections, ['battery', 'chassis', 'report']);
  });

  it('rejects other incompatible combinations', async () => {
    // Entry 1 has battery + report + chassis, try to add electric
    const res = await client.post('/api/admin/register/electric', {
      body: { num: 1, phone: '01012345678' },
      cookie: chiefCookie,
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
      cookie: chiefCookie,
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
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('applies cancel penalty (register after cancel)', async () => {
    // Register entry 2 to electric
    await client.post('/api/admin/register/electric', {
      body: { num: 2, phone: '01098765432' },
      cookie: chiefCookie,
    });
    // Cancel it (applies penalty)
    await client.post('/api/admin/cancel/electric', {
      body: { num: 2 },
      cookie: officialCookie,
    });
    // Try to re-register immediately - should be 403 (penalty)
    const res = await client.post('/api/admin/register/electric', {
      body: { num: 2, phone: '01098765432' },
      cookie: chiefCookie,
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
    assert.equal(penalty.phone, '01012345678');
    const originalRegister = db.prepare("SELECT timestamp FROM queue_log WHERE num = 1 AND inspection = 'report' AND event = 'register' ORDER BY id DESC").get();
    assert.equal(penalty.queue_timestamp, originalRegister.timestamp);
    // Clean up
    db.prepare("DELETE FROM cancel_penalty WHERE num = 1 AND inspection = 'report'").run();
  });

  it('handles current inspection state', async () => {
    // Entry 1 currently has battery,chassis (report was cancelled)
    const types = db.prepare("SELECT inspection FROM current_inspection WHERE num = 1").all().map((row) => row.inspection);
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

// ─── Active cancel penalties ───────────────────────────────────────────
describe('Active cancel penalty management', () => {
  it('requires official permission', async () => {
    const unauthenticated = await client.get('/api/admin/penalties');
    assert.equal(unauthenticated.status, 401);

    const student = await client.get('/api/admin/penalties', { cookie: studentCookie });
    assert.equal(student.status, 403);
  });

  it('GET /api/admin/penalties returns only active penalties for the current year', async () => {
    const year = new Date().getFullYear();
    const now = Date.now();
    db.prepare('DELETE FROM cancel_penalty').run();
    db.prepare(`
      INSERT INTO cancel_penalty (num, inspection, year, until, phone, queue_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(2, 'battery', year, now + 600000, '01098765432', now - 60000);
    db.prepare('INSERT INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)').run(3, 'electric', year, now - 1000);
    db.prepare('INSERT INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)').run(1, 'report', year - 1, now + 600000);

    const res = await client.get('/api/admin/penalties', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, [{
      num: 2,
      inspection: 'battery',
      inspection_name: '배터리',
      until: now + 600000,
      can_restore: 1,
    }]);
  });

  it('DELETE /api/admin/penalties/:type/:num clears an active penalty', async () => {
    const res = await client.delete('/api/admin/penalties/battery/2', { cookie: officialCookie });
    assert.equal(res.status, 200);

    const penalty = db.prepare("SELECT 1 FROM cancel_penalty WHERE num = 2 AND inspection = 'battery'").get();
    assert.equal(penalty, undefined);
    const audit = db.prepare("SELECT * FROM logs WHERE action = 'penalty.clear' AND target = '#2' ORDER BY id DESC").get();
    assert.ok(audit);
    assert.equal(audit.actor_role, 'official');
  });

  it('rejects invalid penalty targets', async () => {
    const invalidType = await client.delete('/api/admin/penalties/unknown/2', { cookie: officialCookie });
    assert.equal(invalidType.status, 400);

    const invalidNum = await client.delete('/api/admin/penalties/battery/not-a-number', { cookie: officialCookie });
    assert.equal(invalidNum.status, 400);
  });

  it('returns 404 when no active penalty exists', async () => {
    const res = await client.delete('/api/admin/penalties/battery/2', { cookie: officialCookie });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '적용 중인 페널티가 없습니다.');
    db.prepare('DELETE FROM cancel_penalty').run();
  });

  it('POST /api/admin/penalties/:type/:num/restore restores the original queue timestamp and clears the penalty', async () => {
    const register = await client.post('/api/admin/register/noise', {
      body: { num: 3, phone: '01033334444' },
      cookie: chiefCookie,
    });
    assert.equal(register.status, 201);
    const year = new Date().getFullYear();
    const original = db.prepare("SELECT phone, timestamp FROM inspection_queue WHERE inspection = 'noise' AND num = 3 AND year = ?").get(year);

    const cancel = await client.post('/api/admin/cancel/noise', {
      body: { num: 3 },
      cookie: officialCookie,
    });
    assert.equal(cancel.status, 200);

    // 취소 후 등록된 팀보다 앞선 원래 타임스탬프로 돌아가는지 확인한다.
    db.prepare("INSERT INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('noise', 2, '01022223333', original.timestamp + 60000, year);
    db.prepare("INSERT INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)")
      .run(2, 'noise', '01022223333', year);

    const restore = await client.post('/api/admin/penalties/noise/3/restore', { cookie: officialCookie });
    assert.equal(restore.status, 200);

    const restored = db.prepare("SELECT phone, timestamp FROM inspection_queue WHERE inspection = 'noise' AND num = 3 AND year = ?").get(year);
    assert.deepEqual(restored, original);
    assert.equal(db.prepare("SELECT 1 FROM cancel_penalty WHERE inspection = 'noise' AND num = 3 AND year = ?").get(year), undefined);
    assert.ok(db.prepare("SELECT 1 FROM current_inspection WHERE inspection = 'noise' AND num = 3 AND year = ?").get(year));
    assert.ok(db.prepare("SELECT 1 FROM queue_log WHERE event = 'restore' AND inspection = 'noise' AND num = 3 AND year = ?").get(year));
    const queue = await client.get('/api/admin/inspection/noise', { cookie: officialCookie });
    assert.deepEqual((await queue.json()).map((entry) => entry.num), [3, 2]);
    const stats = await client.get('/api/admin/stats/3', { cookie: officialCookie });
    assert.ok((await stats.json()).timeline.some((event) => event.event === 'restore'));
    const audit = db.prepare("SELECT * FROM logs WHERE action = 'penalty.restore' AND target = '#3' ORDER BY id DESC").get();
    assert.equal(audit.actor_role, 'official');

    db.prepare("DELETE FROM inspection_queue WHERE inspection = 'noise' AND num IN (2, 3) AND year = ?").run(year);
    db.prepare("DELETE FROM current_inspection WHERE inspection = 'noise' AND num IN (2, 3) AND year = ?").run(year);
    db.prepare("DELETE FROM queue_log WHERE inspection = 'noise' AND num = 3 AND year = ?").run(year);
  });

  it('does not restore a legacy penalty without original queue data', async () => {
    const year = new Date().getFullYear();
    db.prepare('INSERT INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)')
      .run(3, 'noise', year, Date.now() + 600000);

    const restore = await client.post('/api/admin/penalties/noise/3/restore', { cookie: officialCookie });
    assert.equal(restore.status, 409);
    assert.equal(await restore.text(), '취소 당시 대기열 정보가 없어 원래 순번으로 복구할 수 없습니다.');
    assert.ok(db.prepare("SELECT 1 FROM cancel_penalty WHERE inspection = 'noise' AND num = 3 AND year = ?").get(year));
    db.prepare("DELETE FROM cancel_penalty WHERE inspection = 'noise' AND num = 3 AND year = ?").run(year);
  });

  it('keeps the penalty when its inspection is inactive', async () => {
    const year = new Date().getFullYear();
    db.prepare(`
      INSERT INTO cancel_penalty (num, inspection, year, until, phone, queue_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(3, 'rain', year, Date.now() + 600000, '01033334444', Date.now() - 60000);
    db.prepare("UPDATE inspection SET active = 0 WHERE type = 'rain'").run();

    try {
      const restore = await client.post('/api/admin/penalties/rain/3/restore', { cookie: officialCookie });
      assert.equal(restore.status, 400);
      assert.equal(await restore.text(), '대기열이 비활성화 상태입니다.');
      assert.ok(db.prepare("SELECT 1 FROM cancel_penalty WHERE inspection = 'rain' AND num = 3 AND year = ?").get(year));
      assert.equal(db.prepare("SELECT 1 FROM inspection_queue WHERE inspection = 'rain' AND num = 3 AND year = ?").get(year), undefined);
      assert.equal(db.prepare("SELECT 1 FROM current_inspection WHERE inspection = 'rain' AND num = 3 AND year = ?").get(year), undefined);
    } finally {
      db.prepare("UPDATE inspection SET active = 1 WHERE type = 'rain'").run();
      db.prepare("DELETE FROM cancel_penalty WHERE inspection = 'rain' AND num = 3 AND year = ?").run(year);
      db.prepare("DELETE FROM inspection_queue WHERE inspection = 'rain' AND num = 3 AND year = ?").run(year);
      db.prepare("DELETE FROM current_inspection WHERE inspection = 'rain' AND num = 3 AND year = ?").run(year);
    }
  });

  it('keeps the penalty when restoring would violate concurrent registration rules', async () => {
    const year = new Date().getFullYear();
    db.prepare("INSERT INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)")
      .run(3, 'electric', '01033334444', year);
    db.prepare(`
      INSERT INTO cancel_penalty (num, inspection, year, until, phone, queue_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(3, 'battery', year, Date.now() + 600000, '01033334444', Date.now() - 60000);

    const restore = await client.post('/api/admin/penalties/battery/3/restore', { cookie: officialCookie });
    assert.equal(restore.status, 400);
    assert.match(await restore.text(), /이미 전기 검차에 등록된 엔트리/);
    assert.ok(db.prepare("SELECT 1 FROM cancel_penalty WHERE inspection = 'battery' AND num = 3 AND year = ?").get(year));
    assert.equal(db.prepare("SELECT 1 FROM inspection_queue WHERE inspection = 'battery' AND num = 3 AND year = ?").get(year), undefined);

    db.prepare("DELETE FROM current_inspection WHERE num = 3 AND year = ?").run(year);
    db.prepare("DELETE FROM cancel_penalty WHERE num = 3 AND year = ?").run(year);
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
      cookie: chiefCookie,
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
  const statsTeam = 91;
  let statsBase;

  before(() => {
    const year = new Date().getFullYear();
    statsBase = Date.now() + 10_000;
    const insertQueueLog = db.prepare(
      'INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)'
    );
    insertQueueLog.run('register', statsTeam, 'battery', statsBase + 100, year);
    insertQueueLog.run('cancel', statsTeam, 'battery', statsBase + 200, year);
    insertQueueLog.run('register', statsTeam, 'electric', statsBase + 300, year);
    insertQueueLog.run('enter', statsTeam, 'battery', statsBase + 500, year);
    insertQueueLog.run('enter', statsTeam, 'electric', statsBase + 900, year);

    const insertBoothLog = db.prepare(
      'INSERT INTO booth_log (num, inspection, booth_num, entered_at, exited_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertBoothLog.run(statsTeam, 'battery', 1, statsBase + 500, statsBase + 800, statsBase + 500, year);
    insertBoothLog.run(statsTeam, 'electric', 1, statsBase + 900, statsBase + 1400, statsBase + 900, year);
  });

  it('GET /api/admin/stats/timerange returns time range', async () => {
    const res = await client.get('/api/admin/stats/timerange', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.from <= statsBase + 100);
    assert.ok(data.to >= statsBase + 1400);
  });

  it('GET /api/admin/stats returns exact aggregate counts', async () => {
    const res = await client.get('/api/admin/stats', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    const stats = data.find(d => d.num === statsTeam);
    assert.deepEqual(stats, {
      num: statsTeam,
      registrations: 2,
      cancellations: 1,
      entries: 2,
      totalOccupyTime: 800,
    });
  });

  it('GET /api/admin/stats filters by inspection type', async () => {
    const res = await client.get('/api/admin/stats?inspection=battery', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const stats = data.find(d => d.num === statsTeam);
    assert.deepEqual(stats, {
      num: statsTeam,
      registrations: 1,
      cancellations: 1,
      entries: 1,
      totalOccupyTime: 300,
    });
  });

  it('GET /api/admin/stats/:num returns an ordered team timeline and summary', async () => {
    const res = await client.get(`/api/admin/stats/${statsTeam}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.summary, {
      registrations: 2,
      cancellations: 1,
      entries: 2,
      totalOccupyTime: 800,
    });
    assert.deepEqual(data.timeline.map(e => e.event), [
      'register', 'cancel', 'register', 'enter', 'exit', 'enter', 'exit',
    ]);
    assert.deepEqual(data.timeline.map(e => e.timestamp), [
      100, 200, 300, 500, 800, 900, 1400,
    ].map(offset => statsBase + offset));
    assert.ok(data.timeline.every(event => event.inspection && event.timestamp));
  });

  it('GET /api/admin/stats/:num applies the requested time range', async () => {
    const res = await client.get(
      `/api/admin/stats/${statsTeam}?from=${statsBase + 150}&to=${statsBase + 600}`,
      { cookie: officialCookie }
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.summary, {
      registrations: 1,
      cancellations: 1,
      entries: 1,
      totalOccupyTime: 0,
    });
    assert.deepEqual(data.timeline.map(e => e.event), ['cancel', 'register', 'enter']);
    assert.deepEqual(data.timeline.map(e => e.timestamp), [
      statsBase + 200,
      statsBase + 300,
      statsBase + 500,
    ]);
  });

  it('GET /api/admin/stats/:num timeline shows enter of an in-progress (not-yet-exited) session under a to filter', async () => {
    // Regression: an occupied booth (entered, exited_at IS NULL) must appear
    // as an "enter" timeline event immediately — not only once it exits. The
    // stats page always sends a `to` filter, so a `to`-gated exited_at check
    // used to hide open sessions until 출차.
    await client.post('/api/admin/register/electric', {
      body: { num: 3, phone: '01055551234' },
      cookie: chiefCookie,
    });
    const enterRes = await client.post('/api/admin/booths/electric/1/enter', {
      body: { num: 3 },
      cookie: officialCookie,
    });
    assert.equal(enterRes.status, 200);

    // Booth is now occupied and NOT exited.
    const to = Date.now() + 60000; // window end in the near future
    const res = await client.get(`/api/admin/stats/3?from=0&to=${to}&inspection=electric`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const events = data.timeline.map(e => e.event);
    assert.ok(events.includes('enter'), 'open session enter event should be visible under a to filter');
    assert.ok(!events.includes('exit'), 'no exit event yet for an in-progress session');

    // Cleanup: exit so later state is clean.
    await client.post('/api/admin/booths/electric/1/exit', { cookie: officialCookie });
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
      const queue = db.prepare("SELECT num FROM inspection_queue WHERE inspection = ?").all(type);
      for (const entry of queue) {
        await client.post(`/api/admin/cancel/${type}`, {
          body: { num: entry.num },
          cookie: officialCookie,
        });
      }
    }
    db.prepare("DELETE FROM cancel_penalty").run();
    db.prepare("DELETE FROM current_inspection").run();
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
      cookie: chiefCookie,
    });

    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));

    // Register entry 3 (first inspection)
    await client.post('/api/admin/register/battery', {
      body: { num: 3, phone: '01011112222' },
      cookie: chiefCookie,
    });

    await new Promise(r => setTimeout(r, 10));

    // Register entry 1 (first inspection, registered after entry 3)
    await client.post('/api/admin/register/battery', {
      body: { num: 1, phone: '01012345678' },
      cookie: chiefCookie,
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
      db.prepare("DELETE FROM inspection_queue WHERE inspection = ?").run(type);
    }
    db.prepare("DELETE FROM cancel_penalty").run();
    db.prepare("DELETE FROM current_inspection").run();

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
      cookie: chiefCookie,
      body: { num: 1, phone: '01011111111' },
    });

    await new Promise(r => setTimeout(r, 10));

    // Register entry 2 with high priority
    await client.post(`/api/admin/priority/${testType}`, {
      cookie: chiefCookie,
      body: { num: 2, priority: 1 },
    });
    await client.post(`/api/admin/register/${testType}`, {
      cookie: chiefCookie,
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
      cookie: chiefCookie,
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
      cookie: chiefCookie,
      body: { num: 1, phone: '01011111111' },
    });

    await new Promise(r => setTimeout(r, 10));

    await client.post(`/api/admin/register/${testType}`, {
      cookie: chiefCookie,
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

  it('broadcasts penalty invalidation without protected penalty data', async () => {
    const year = new Date().getFullYear();
    db.prepare(`
      INSERT OR REPLACE INTO cancel_penalty (num, inspection, year, until, phone, queue_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(3, 'electric', year, Date.now() + 600000, '01033334444', Date.now());

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      const init = await reader.read();
      assert.match(decoder.decode(init.value), /event: init/);

      const clear = await client.delete('/api/admin/penalties/electric/3', { cookie: officialCookie });
      assert.equal(clear.status, 200);

      const event = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('penalty SSE timeout')), 2000)),
      ]);
      const payload = decoder.decode(event.value);
      assert.match(payload, /event: penalties/);
      assert.match(payload, /data: \{\}/);
      assert.doesNotMatch(payload, /01033334444|queue_timestamp|electric/);
    } finally {
      controller.abort();
    }
  });
});

// ─── Additional edge cases ──────────────────────────────────────────────
describe('Validation edge cases', () => {
  it('rejects invalid entry number in register', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: -1, phone: '01012345678' },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing phone in register', async () => {
    const res = await client.post('/api/admin/register/battery', {
      body: { num: 1 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid inspection type', async () => {
    const res = await client.post('/api/admin/register/nonexistent', {
      body: { num: 1, phone: '01012345678' },
      cookie: chiefCookie,
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
      const current = db.prepare("SELECT inspection FROM current_inspection WHERE num = 1").all();
      if (current.length) {
        for (const { inspection: type } of current) {
          await client.post(`/api/admin/cancel/${type}`, { body: { num: 1 }, cookie: officialCookie });
        }
        db.prepare("DELETE FROM cancel_penalty WHERE num = 1").run();
      }
      await client.post('/api/admin/register/battery', {
        body: { num: 1, phone: '01012345678' },
        cookie: chiefCookie,
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
    db.prepare("DELETE FROM current_inspection WHERE num = 3").run();
    db.prepare("DELETE FROM cancel_penalty WHERE num = 3").run();

    // Register entry 3 in both battery and report (report is always compatible)
    await client.post('/api/admin/register/battery', {
      cookie: chiefCookie,
      body: { num: 3, phone: '01033333333' },
    });
    await client.post('/api/admin/register/report', {
      cookie: chiefCookie,
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

// ─── Internal API: team deletion ─────────────────────────────────────────
describe('DELETE /api/internal/team/:num', () => {
  before(async () => {
    // Activate noise inspection and register entry 2 for cleanup tests
    await client.patch('/api/admin/inspection/noise', {
      body: { active: true },
      cookie: chiefCookie,
    });
    await client.post('/api/admin/register/noise', {
      body: { num: 2, phone: '01022222222' },
      cookie: chiefCookie,
    });
    // Set priority for entry 2 in noise
    await client.post('/api/admin/priority/noise', {
      body: { num: 2, priority: 1 },
      cookie: chiefCookie,
    });
  });

  it('requires admin auth (internal service header)', async () => {
    const res = await client.delete('/api/internal/team/2?year=' + new Date().getFullYear());
    assert.equal(res.status, 401);
  });

  it('cleans up all queue data for the team', async () => {
    const year = new Date().getFullYear();

    // Verify entry 2 is in noise queue before cleanup
    const queueBefore = await client.get('/api/admin/inspection/noise', { cookie: officialCookie });
    const beforeData = await queueBefore.json();
    assert.ok(beforeData.some(e => e.num === 2), 'entry 2 should be in noise queue before cleanup');

    // Call internal delete
    const res = await client.delete(`/api/internal/team/2?year=${year}`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    // Verify entry 2 is removed from noise queue
    const queueAfter = await client.get('/api/admin/inspection/noise', { cookie: officialCookie });
    const afterData = await queueAfter.json();
    assert.ok(!afterData.some(e => e.num === 2), 'entry 2 should be removed from noise queue');

    // Verify priority is removed
    const priorities = await client.get('/api/admin/priority/noise', { cookie: chiefCookie });
    const prioData = await priorities.json();
    assert.ok(!prioData.some(e => e.num === 2), 'entry 2 priority should be removed');
  });

  it('returns 400 for invalid entry number', async () => {
    const res = await client.delete('/api/internal/team/abc?year=' + new Date().getFullYear(), {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns 400 when year is missing or invalid', async () => {
    const missing = await client.delete('/api/internal/team/2', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(missing.status, 400);

    const invalid = await client.delete('/api/internal/team/2?year=abc', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(invalid.status, 400);
  });
});

// ─── Internal API: team renumber ────────────────────────────────────────
describe('PATCH /api/internal/team-num', () => {
  it('renumbers queue rows, priorities, penalties, history, booths, and logs', async () => {
    const year = new Date().getFullYear();
    db.prepare("INSERT OR REPLACE INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('braking', 903, '01033333333', Date.now(), year);
    db.prepare("INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)")
      .run(903, 'braking', '01033333333', year);
    db.prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)")
      .run(903, 'braking', year, 2);
    db.prepare("INSERT OR REPLACE INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)")
      .run(903, 'braking', year, Date.now() + 60000);
    db.prepare("INSERT OR IGNORE INTO inspection_history (num, inspection, timestamp, year) VALUES (?, ?, ?, ?)")
      .run(903, 'braking', Date.now(), year);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?)")
      .run(903, 'braking', 1, Date.now(), Date.now(), year);
    db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('register', 903, 'braking', Date.now(), year);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, exited_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(904, 'braking', 2, Date.now() - 1000, Date.now(), Date.now(), year);
    db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('cancel', 904, 'braking', Date.now(), year);
    db.prepare("UPDATE booth SET occupied_by = ?, entered_at = ? WHERE inspection = ? AND booth_num = 1")
      .run(903, Date.now(), 'braking');

    const res = await client.patch('/api/internal/team-num', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { prevNum: 903, newNum: 904, year },
    });
    assert.equal(res.status, 200);

    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?").get('braking', 904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM current_inspection WHERE inspection = ? AND num = ? AND year = ?").get('braking', 904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_priority WHERE num = ? AND year = ?").get(904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM cancel_penalty WHERE num = ? AND year = ?").get(904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_history WHERE num = ? AND year = ?").get(904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM booth_log WHERE num = ? AND year = ?").get(904, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM queue_log WHERE event = 'cancel' AND num = ? AND year = ?").get(904, year).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM queue_log WHERE event = 'register' AND num = ? AND year = ?").get(904, year).c, 1);
    assert.equal(db.prepare("SELECT occupied_by FROM booth WHERE inspection = ? AND booth_num = 1").get('braking').occupied_by, 904);
    assert.ok(db.prepare("SELECT COUNT(*) AS c FROM queue_log WHERE event = 'renumber' AND num = ? AND year = ?").get(904, year).c >= 1);
  });

  it('treats prevNum === newNum as a no-op and preserves the team\'s rows', async () => {
    const year = new Date().getFullYear();
    db.prepare("INSERT OR REPLACE INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('braking', 905, '01055555555', Date.now(), year);
    db.prepare("INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)")
      .run(905, 'braking', '01055555555', year);
    db.prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)")
      .run(905, 'braking', year, 1);

    const res = await client.patch('/api/internal/team-num', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { prevNum: 905, newNum: 905, year },
    });
    assert.equal(res.status, 200);

    // self-renumber는 목적지(=자기 번호) 행을 먼저 지우므로, 가드가 없으면 데이터가 사라진다.
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?").get('braking', 905, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM current_inspection WHERE inspection = ? AND num = ? AND year = ?").get('braking', 905, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_priority WHERE num = ? AND year = ?").get(905, year).c, 1);
  });

  it('applies deactivation cleanup after renumbering in the same bulk lifecycle sequence', async () => {
    const year = new Date().getFullYear();
    const prevNum = 906;
    const newNum = 907;
    db.prepare("INSERT OR REPLACE INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('braking', prevNum, '01077777777', Date.now(), year);
    db.prepare("INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)")
      .run(prevNum, 'braking', '01077777777', year);
    db.prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)")
      .run(prevNum, 'braking', year, 1);
    db.prepare("INSERT OR REPLACE INTO team_status (year, team_num, active, revision) VALUES (?, ?, 1, 60)")
      .run(year, prevNum);

    const renumber = await client.patch('/api/internal/team-num', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: {
        prevNum,
        newNum,
        year,
        entry: { univ: 'U', team: 'T', active: false, active_revision: 61 },
      },
    });
    assert.equal(renumber.status, 200);
    assert.deepEqual(
      db.prepare("SELECT active, revision FROM team_status WHERE year = ? AND team_num = ?").get(year, newNum),
      { active: 1, revision: 60 },
      'renumber must preserve the previous status so the following event is not deduplicated',
    );

    const deactivate = await client.patch('/api/internal/team-active', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { num: newNum, year, active: false, revision: 61 },
    });
    assert.equal(deactivate.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_queue WHERE num = ? AND year = ?").get(newNum, year).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM current_inspection WHERE num = ? AND year = ?").get(newNum, year).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_priority WHERE num = ? AND year = ?").get(newNum, year).c, 0);
    assert.deepEqual(
      db.prepare("SELECT active, revision FROM team_status WHERE year = ? AND team_num = ?").get(year, newNum),
      { active: 0, revision: 61 },
    );
  });
});

// ─── Year isolation ──────────────────────────────────────────────────────
describe('Year isolation', () => {
  it('queue queries filter by current year', async () => {
    // Register entry 2 — should use current year automatically
    await client.post('/api/admin/register/tilting', {
      body: { num: 2, phone: '01022222222' },
      cookie: chiefCookie,
    });
    const queue = await client.get('/api/admin/inspection/tilting', { cookie: officialCookie });
    const data = await queue.json();
    assert.ok(data.some(e => e.num === 2), 'entry should be in tilting queue');

    // Verify year column is present
    assert.equal(data[0].year, new Date().getFullYear(), 'year column should be current year');
  });

  it('stats APIs filter by year even when no from/to range is supplied', async () => {
    const year = 2033;
    const otherYear = 2034;
    const now = Date.now();
    db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('register', 777, 'battery', now, year);
    db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)")
      .run('register', 778, 'battery', now, otherYear);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, exited_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(777, 'battery', 1, now, now + 1000, now, year);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, exited_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(778, 'battery', 1, now, now + 1000, now, otherYear);

    const statsRes = await client.get(`/api/admin/stats?year=${year}`, { cookie: officialCookie });
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.ok(stats.some((row) => row.num === 777), 'selected year row should be included');
    assert.ok(!stats.some((row) => row.num === 778), 'other year row should be excluded');

    const detailRes = await client.get(`/api/admin/stats/778?year=${year}`, { cookie: officialCookie });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.summary.registrations, 0);
    assert.equal(detail.timeline.length, 0);
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

// ─── Legacy → normalized migration ───────────────────────────────────────
describe('Queue legacy → normalized migration', () => {
  const Database = require('better-sqlite3');
  let migPath, migDb;
  const yr = new Date().getFullYear();

  before(() => {
    migPath = tmpDbPath();
    const seed = new Database(migPath);
    // legacy inspection meta WITH the removed `length` cache column
    seed.exec(`CREATE TABLE inspection (type TEXT PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, length INTEGER NOT NULL DEFAULT 0)`);
    seed.prepare("INSERT INTO inspection (type, name, active, length) VALUES (?, ?, ?, ?)").run('battery', '배터리', 1, 7);
    // legacy `current` (no year column); inspection is a comma list incl. an invalid type
    seed.exec(`CREATE TABLE current (num INTEGER PRIMARY KEY, phone TEXT, inspection TEXT)`);
    seed.prepare("INSERT INTO current (num, phone, inspection) VALUES (?, ?, ?)").run(1, '01011112222', 'battery,braking,bogus');
    // legacy per-inspection queue table
    seed.exec(`CREATE TABLE battery (num INTEGER PRIMARY KEY, phone TEXT, timestamp INTEGER)`);
    seed.prepare("INSERT INTO battery (num, phone, timestamp) VALUES (?, ?, ?)").run(10, '01099998888', 1000);
    seed.prepare("INSERT INTO battery (num, phone, timestamp) VALUES (?, ?, ?)").run(11, '01077776666', 2000);
    // legacy inspection_history with a NON-year-scoped PK
    seed.exec(`CREATE TABLE inspection_history (num INTEGER NOT NULL, inspection TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (num, inspection))`);
    seed.prepare("INSERT INTO inspection_history (num, inspection, timestamp) VALUES (?, ?, ?)").run(5, 'braking', 1234);
    // 현재 운영 스키마에는 year가 있지만 순번 복구용 컬럼은 없는 상태
    seed.exec(`CREATE TABLE cancel_penalty (
      num INTEGER NOT NULL,
      inspection TEXT NOT NULL,
      year INTEGER NOT NULL,
      until INTEGER NOT NULL,
      PRIMARY KEY (num, inspection, year)
    )`);
    seed.prepare("INSERT INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)")
      .run(5, 'braking', yr, Date.now() + 60000);
    seed.close();
  });

  after(() => {
    migDb?.close();
    cleanup(migPath);
  });

  it('migrates legacy current/per-inspection/history into normalized tables and drops legacy tables', () => {
    migDb = createQueueApp({ dbPath: migPath }).db;

    // current → current_inspection: comma list split, invalid type dropped, default year applied
    const ci = migDb.prepare("SELECT inspection FROM current_inspection WHERE num = 1 AND year = ? ORDER BY inspection").all(yr).map((r) => r.inspection);
    assert.deepEqual(ci, ['battery', 'braking'], 'comma list split; bogus type filtered out');

    // per-inspection `battery` table → inspection_queue
    const iq = migDb.prepare("SELECT num FROM inspection_queue WHERE inspection = 'battery' AND year = ? ORDER BY num").all(yr).map((r) => r.num);
    assert.deepEqual(iq, [10, 11]);

    // `length` cache column removed from inspection meta
    const insCols = migDb.prepare("PRAGMA table_info(inspection)").all().map((c) => c.name);
    assert.ok(!insCols.includes('length'), 'length cache column removed');

    // inspection_history PK is now year-scoped and the legacy row survived
    const pk = migDb.prepare("PRAGMA table_info(inspection_history)").all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(pk, ['num', 'inspection', 'year', 'timestamp']);
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM inspection_history WHERE num = 5 AND year = ?").get(yr).c, 1);

    // 기존 페널티 행은 유지하고 복구용 nullable 컬럼을 추가한다.
    const penaltyCols = migDb.prepare("PRAGMA table_info(cancel_penalty)").all().map((c) => c.name);
    assert.ok(penaltyCols.includes('phone'));
    assert.ok(penaltyCols.includes('queue_timestamp'));
    const legacyPenalty = migDb.prepare("SELECT phone, queue_timestamp FROM cancel_penalty WHERE num = 5 AND year = ?").get(yr);
    assert.deepEqual(legacyPenalty, { phone: null, queue_timestamp: null });

    // legacy tables consumed
    const has = (t) => !!migDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    assert.equal(has('current'), false, 'legacy current consumed');
    assert.equal(has('battery'), false, 'legacy per-inspection table dropped');

    // current는 DROP되지 않고 current_legacy로 보존되어, INSPECTIONS에서 사라진 타입으로만
    // 등록된 행도 잃지 않는다(원본 raw 행 보존).
    assert.equal(has('current_legacy'), true, 'legacy current preserved as current_legacy');
    assert.equal(migDb.prepare("SELECT inspection FROM current_legacy WHERE num = 1").get().inspection, 'battery,braking,bogus');
  });

  it('is idempotent — re-opening the migrated DB makes no further changes and does not error', () => {
    migDb.close();
    migDb = createQueueApp({ dbPath: migPath }).db;
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM current_inspection WHERE num = 1").get().c, 2);
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM inspection_queue WHERE inspection = 'battery'").get().c, 2);
    assert.equal(migDb.prepare("SELECT COUNT(*) AS c FROM inspection_history WHERE num = 5").get().c, 1);
  });
});

describe('Entry active-state synchronization', () => {
  const year = new Date().getFullYear();
  const num = 990;

  it('clears only transient state, hides history, and ignores stale revisions', async () => {
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES ('battery', ?, '01099999999', ?, ?)").run(num, now, year);
    db.prepare("INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, 'battery', '01099999999', ?)").run(num, year);
    db.prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, 'battery', ?, 1)").run(num, year);
    db.prepare("INSERT OR REPLACE INTO cancel_penalty (num, inspection, year, until, phone, queue_timestamp) VALUES (?, 'battery', ?, ?, '01099999999', ?)").run(num, year, now + 60000, now);
    db.prepare("INSERT INTO inspection_history (num, inspection, timestamp, year) VALUES (?, 'battery', ?, ?)").run(num, now, year);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, exited_at, created_at, year) VALUES (?, 'battery', 1, ?, ?, ?, ?)").run(num, now - 2000, now - 1000, now - 2000, year);
    db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, created_at, year) VALUES (?, 'battery', 1, ?, ?, ?)").run(num, now, now, year);
    db.prepare("UPDATE booth SET occupied_by = ?, entered_at = ? WHERE inspection = 'battery' AND booth_num = 1").run(num, now);
    db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES ('register', ?, 'battery', ?, ?)").run(num, now, year);

    const deactivate = await client.patch('/api/internal/team-active', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { num, year, active: false, revision: 10 },
    });
    assert.equal(deactivate.status, 200);
    for (const table of ['inspection_queue', 'current_inspection', 'team_priority', 'cancel_penalty']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE num = ? AND year = ?`).get(num, year).c, 0, `${table} cleared`);
    }
    assert.equal(db.prepare("SELECT occupied_by FROM booth WHERE inspection = 'battery' AND booth_num = 1").get().occupied_by, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM booth_log WHERE num = ? AND year = ? AND exited_at IS NULL").get(num, year).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM booth_log WHERE num = ? AND year = ? AND exited_at IS NOT NULL").get(num, year).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_history WHERE num = ? AND year = ?").get(num, year).c, 1);

    const history = await (await client.get('/api/admin/history/status', { cookie: chiefCookie })).json();
    assert.ok(!(history.battery || []).includes(num));
    const stats = await (await client.get(`/api/admin/stats?year=${year}`, { cookie: officialCookie })).json();
    assert.ok(!stats.some((row) => row.num === num));
    assert.equal((await client.get(`/api/admin/stats/${num}?year=${year}`, { cookie: officialCookie })).status, 404);

    await client.patch('/api/internal/team-active', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { num, year, active: true, revision: 9 },
    });
    assert.equal(db.prepare("SELECT active, revision FROM team_status WHERE year = ? AND team_num = ?").get(year, num).active, 0);

    await client.patch('/api/internal/team-active', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { num, year, active: true, revision: 11 },
    });
    assert.equal(db.prepare("SELECT active FROM team_status WHERE year = ? AND team_num = ?").get(year, num).active, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM inspection_queue WHERE num = ? AND year = ?").get(num, year).c, 0, 'transient queue is not restored');
    const restoredHistory = await (await client.get('/api/admin/history/status', { cookie: chiefCookie })).json();
    assert.ok((restoredHistory.battery || []).includes(num), 'preserved history is visible again');
  });
});
