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
  TRUST_JWT,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createCourseApp } from '../../course/index.mjs';

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createCourseApp({ dbPath, validateUser: TRUST_JWT });
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

// ─── Auth ───────────────────────────────────────────────────────────────
describe('Auth enforcement', () => {
  const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
  const queueManagerCookie = makeAuthCookie({
    email: 'queue-manager@test.com', name: 'Queue Manager', role: 'official', permissions: ['queue.manage'],
  });
  const courseOperatorCookie = makeAuthCookie({
    email: 'course-operator@test.com', name: 'Course Operator', role: 'official', permissions: ['course.operate'],
  });
  const courseManagerCookie = makeAuthCookie({
    email: 'course-manager@test.com', name: 'Course Manager', role: 'official', permissions: ['course.manage'],
  });
  const roverOperatorCookie = makeAuthCookie({
    email: 'rover-operator@test.com', name: 'Rover Operator', role: 'official', permissions: ['rover.operate'],
  });

  it('rejects unauthenticated requests to /api/courses', async () => {
    const res = await client.get('/api/courses');
    assert.equal(res.status, 401);
  });

  it('rejects human roles and unrelated service grants from /api/courses', async () => {
    const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
    const studentRes = await client.get('/api/courses', { cookie: studentCookie });
    assert.equal(studentRes.status, 403);
    const officialRes = await client.get('/api/courses', { cookie: officialCookie });
    assert.equal(officialRes.status, 403);
    const unrelatedRes = await client.get('/api/courses', { cookie: queueManagerCookie });
    assert.equal(unrelatedRes.status, 403);
  });

  it('allows course.operate to edit courses', async () => {
    const res = await client.get('/api/courses', { cookie: courseOperatorCookie });
    assert.equal(res.status, 200);
  });

  it('lists device addresses only to rover operators', async () => {
    const courseManager = await client.get('/api/devices', { cookie: courseManagerCookie });
    assert.equal(courseManager.status, 403);
    const rover = await client.get('/api/devices', { cookie: roverOperatorCookie });
    assert.equal(rover.status, 200);
    assert.deepEqual(await rover.json(), { devices: [] });
  });

  it('limits mission presets to rover operators', async () => {
    for (const cookie of [courseOperatorCookie, courseManagerCookie]) {
      assert.equal((await client.get('/api/courses/99999/mission-presets', { cookie })).status, 403);
      assert.equal((await client.delete('/api/courses/99999/mission-presets/1', { cookie, body: {} })).status, 403);
    }
    // A missing course proves the permission gate passed.
    assert.equal((await client.get('/api/courses/99999/mission-presets', { cookie: roverOperatorCookie })).status, 404);
    assert.equal(
      (await client.delete('/api/courses/99999/mission-presets/1', { cookie: roverOperatorCookie, body: {} })).status,
      404,
    );
  });

  it('lets course operators take a snapshot but not list or restore them', async () => {
    const take = await client.post('/api/courses/99999/snapshots', { cookie: courseOperatorCookie, body: {} });
    assert.equal(take.status, 404);
    const list = await client.get('/api/courses/99999/snapshots', { cookie: courseOperatorCookie });
    assert.equal(list.status, 403);
  });

  it('requires course.manage for destructive course and snapshot operations', async () => {
    const deleteDenied = await client.delete('/api/courses/1', { cookie: courseOperatorCookie });
    assert.equal(deleteDenied.status, 403);
    const snapshotDenied = await client.get('/api/courses/1/snapshots', { cookie: courseOperatorCookie });
    assert.equal(snapshotDenied.status, 403);

    const deleteAllowed = await client.delete('/api/courses/99999', { cookie: courseManagerCookie });
    assert.equal(deleteAllowed.status, 404);
    const snapshotAllowed = await client.get('/api/courses/99999/snapshots', { cookie: courseManagerCookie });
    assert.equal(snapshotAllowed.status, 404);
  });

  it('applies the course.manage gates to ids that parseInt would still accept', async () => {
    const deleteDenied = await client.delete('/api/courses/1a', { cookie: courseOperatorCookie });
    assert.equal(deleteDenied.status, 403);
    const listDenied = await client.get('/api/courses/1a/snapshots', { cookie: courseOperatorCookie });
    assert.equal(listDenied.status, 403);
    const restoreDenied = await client.post('/api/courses/1a/snapshots/1/restore', { cookie: courseOperatorCookie, body: {} });
    assert.equal(restoreDenied.status, 403);
    const snapshotDeleteDenied = await client.delete('/api/courses/1a/snapshots/1', { cookie: courseOperatorCookie });
    assert.equal(snapshotDeleteDenied.status, 403);

    const take = await client.post('/api/courses/99999a/snapshots', { cookie: courseOperatorCookie, body: {} });
    assert.equal(take.status, 404);
    const deleteAllowed = await client.delete('/api/courses/99999a', { cookie: courseManagerCookie });
    assert.equal(deleteAllowed.status, 404);
  });
});

// Course data rules (validation, ordering, cascades, import/export) are tested
// in fsk-coursekeeper. These cover what FSK adds around the shared service:
// audit logs, the retired mission tables, role gates, and FSK DB migrations.

// ─── Audit logs ─────────────────────────────────────────────────────────
describe('Course audit logs', () => {
  const courseName = '로그 코스';
  let courseId;

  before(async () => {
    const res = await client.post('/api/courses', { body: { name: courseName }, cookie: adminCookie });
    courseId = (await res.json()).id;
  });

  it('keeps the original SQLite cause in route failure logs', async () => {
    db.exec(`CREATE TEMP TRIGGER fail_route_marker_insert
      BEFORE INSERT ON route_marker
      BEGIN SELECT RAISE(ABORT, 'injected route storage failure'); END`);
    try {
      const res = await client.post(`/api/courses/${courseId}/route/markers`, {
        body: { lat: 35.294, lng: 126.576, label: '실패 주입' }, cookie: adminCookie,
      });
      assert.equal(res.status, 500);
      assert.equal(await res.text(), 'Server error.');
      const warning = db.prepare(`SELECT detail FROM logs
        WHERE action = 'route_marker.create' AND target = ?
        ORDER BY id DESC LIMIT 1`).get(courseName);
      assert.equal(JSON.parse(warning.detail).error, 'injected route storage failure');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_route_marker_insert');
    }
  });

  it('logs import validation failures with the actor and structured detail', async () => {
    const res = await client.post('/api/courses/import', {
      body: {
        name: 'invalid-route-import',
        cones: [],
        route_markers: [{ lat: 91, lng: 126.1, label: 'invalid' }],
        route_steps: [0],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);

    const log = db.prepare(
      "SELECT level, actor_email, detail FROM logs WHERE action = 'course.import' AND target = ? ORDER BY id DESC LIMIT 1",
    ).get('invalid-route-import');
    assert.equal(log.level, 'warn');
    assert.equal(log.actor_email, 'admin@test.com');
    assert.equal(typeof JSON.parse(log.detail).error, 'string');
  });

  it('audits the delete cascade and detaches retired missions', async () => {
    const coneRes = await client.post(`/api/courses/${courseId}/cones`, {
      body: { lat: 35, lng: 126, side: 'left' }, cookie: adminCookie,
    });
    const coneId = (await coneRes.json()).id;
    db.prepare(`INSERT INTO memo (course_id, lat, lng, width, height, content)
      VALUES (?, 35, 126, 2, 1, 'delete audit')`).run(courseId);
    db.prepare(`INSERT INTO course_snapshot (course_id, taken_at, reason, cones_json)
      VALUES (?, ?, 'delete audit', '[]')`).run(courseId, Date.now());
    const presetId = Number(db.prepare(`INSERT INTO mission_route_preset
      (course_id, name, finish_behavior, created_at, updated_at)
      VALUES (?, 'delete audit preset', 'stop', ?, ?)`).run(courseId, Date.now(), Date.now()).lastInsertRowid);
    db.prepare(`INSERT INTO mission_route_preset_item
      (id, preset_id, position, cone_id, cone_id_snapshot, lat_snapshot, lng_snapshot, side_snapshot)
      VALUES ('delete-audit-item', ?, 0, ?, ?, 35, 126, 'left')`).run(presetId, coneId, coneId);
    const missionId = Number(db.prepare(`INSERT INTO mission
      (course_id, started_at, ended_at, status, waypoints_json, lifecycle_state)
      VALUES (?, ?, ?, 'completed', '[]', 'completed')`).run(courseId, Date.now() - 1, Date.now()).lastInsertRowid);
    db.prepare(`INSERT INTO mission_waypoint
      (id, mission_id, position, cone_id, cone_id_snapshot, lat, lng, side, state, created_at, updated_at)
      VALUES ('delete-audit-waypoint', ?, 0, ?, ?, 35, 126, 'left', 'completed', ?, ?)`)
      .run(missionId, coneId, coneId, Date.now(), Date.now());
    const count = (table, where = `course_id = ${courseId}`) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
    const expectedCascade = {
      cones: count('cone'),
      memos: count('memo'),
      route_markers: count('route_marker'),
      route_steps: count('route_step'),
      snapshots: count('course_snapshot'),
      mission_presets: count('mission_route_preset'),
      mission_preset_items: count('mission_route_preset_item', `preset_id = ${presetId}`),
    };

    const res = await client.delete(`/api/courses/${courseId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const courses = await (await client.get('/api/courses', { cookie: adminCookie })).json();
    assert.equal(courses.some((course) => course.id === courseId), false);
    assert.equal(db.prepare('SELECT course_id FROM mission WHERE id = ?').get(missionId).course_id, null);
    assert.equal(
      db.prepare("SELECT cone_id FROM mission_waypoint WHERE id = 'delete-audit-waypoint'").get().cone_id,
      null,
    );
    const audit = db.prepare(`SELECT detail FROM logs
      WHERE action = 'course.delete' AND target = ?
      ORDER BY id DESC LIMIT 1`).get(courseName);
    assert.deepEqual(JSON.parse(audit.detail), { course_id: courseId, cascade: expectedCascade });
  });
});

// ─── Role gates ─────────────────────────────────────────────────────────
describe('Course role gates', () => {
  const masterCookie = makeAuthCookie({ email: 'master@test.com', name: 'Master', role: 'master' });
  const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
  let courseId;

  before(async () => {
    const res = await client.post('/api/courses', { body: { name: '권한 코스' }, cookie: adminCookie });
    courseId = (await res.json()).id;
  });

  // Direction, memos, and bulk cone delete all fall through to the default
  // course.operate gate; one route each shows the gate admits course operators
  // and master, and rejects chief and unrelated grants.
  it('admits course operation on the remaining course routes and rejects lower roles and unrelated grants', async () => {
    const editorCookie = makeAuthCookie({
      email: 'course-editor@test.com', name: 'Course editor', role: 'official', permissions: ['course.operate'],
    });
    const queueCookie = makeAuthCookie({
      email: 'queue-operator@test.com', name: 'Queue operator', role: 'official', permissions: ['queue.operate'],
    });
    const memo = { lat: 37.5, lng: 126.9, width: 10, height: 10 };

    const direction = (cookie, reverse) => client.patch(`/api/courses/${courseId}/direction`, { body: { reverse }, cookie });
    assert.equal((await direction(editorCookie, false)).status, 200);
    assert.equal((await direction(queueCookie, true)).status, 403);

    assert.equal((await client.post(`/api/courses/${courseId}/memos`, { body: memo, cookie: masterCookie })).status, 201);
    assert.equal((await client.get(`/api/courses/${courseId}/memos`, { cookie: chiefCookie })).status, 403);
    assert.equal((await client.post(`/api/courses/${courseId}/memos`, { body: memo, cookie: chiefCookie })).status, 403);

    assert.equal((await client.delete(`/api/courses/${courseId}/cones`, { cookie: masterCookie })).status, 200);
  });

  it('lets master take a snapshot but not list, restore, or delete them', async () => {
    assert.equal((await client.get(`/api/courses/${courseId}/snapshots`, { cookie: masterCookie })).status, 403);
    // A missing course proves the permission gate passed without adding a snapshot.
    assert.equal((await client.post('/api/courses/99999/snapshots', { body: { reason: 'x' }, cookie: masterCookie })).status, 404);
    assert.equal((await client.post(`/api/courses/${courseId}/snapshots/1/restore`, { cookie: masterCookie })).status, 403);
    assert.equal((await client.delete(`/api/courses/${courseId}/snapshots/1`, { cookie: masterCookie })).status, 403);
  });
});

// ─── FSK database migrations ────────────────────────────────────────────
describe('Mission schema migration', () => {
  it('migrates an old-schema mission table, preserving rows and adding progress columns', async () => {
    // better-sqlite3 only resolves from course/node_modules, not from the test
    // dir — reuse the live suite db's constructor to open a raw fixture DB.
    const Database = db.constructor;
    const p = tmpDbPath();
    const raw = new Database(p);
    raw.pragma("foreign_keys = ON");
    // Parent table must exist (mission FK-references it) — mirror production,
    // where course is created before mission.
    raw.exec(`CREATE TABLE course (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);
    // OLD schema: no progress columns, CHECK without paused/interrupted.
    raw.exec(`CREATE TABLE mission (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'stopped', 'error')) DEFAULT 'running',
      waypoints_json TEXT NOT NULL,
      actor TEXT,
      FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
    )`);
    const missionId = raw.prepare("INSERT INTO mission (started_at, status, waypoints_json) VALUES (?, 'completed', ?)")
      .run(Date.now() - 1000, '[{"lat":35,"lng":126}]').lastInsertRowid;
    // Telemetry history with an ON DELETE CASCADE FK onto mission(id). The
    // migration's DROP TABLE mission must NOT cascade-wipe this (it would under
    // foreign_keys=ON without the pragma toggle) — this is the regression guard
    // for the data-loss bug.
    raw.exec(`CREATE TABLE mission_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      t INTEGER NOT NULL, lat REAL, lng REAL, fix_status TEXT, nav_state TEXT,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
    )`);
    raw.prepare("INSERT INTO mission_telemetry (mission_id, t, lat, lng) VALUES (?, ?, ?, ?)")
      .run(missionId, Date.now(), 35.0, 126.0);
    raw.close();

    const { createCourseApp } = await import('../../course/index.mjs?v=migrate');
    const result = createCourseApp({ dbPath: p, validateUser: TRUST_JWT });
    const started = await startServer(result.app);
    try {
      // Existing row preserved through the rebuild.
      const missions = result.db.prepare("SELECT status FROM mission").all();
      assert.deepEqual(missions, [{ status: 'completed' }]);

      // Telemetry history survived (DROP TABLE mission did NOT cascade-delete it).
      const tcount = result.db.prepare("SELECT COUNT(*) AS c FROM mission_telemetry").get().c;
      assert.equal(tcount, 1, 'mission_telemetry must survive the mission table rebuild');

      // New columns present.
      const cols = result.db.prepare("PRAGMA table_info(mission)").all().map((c) => c.name);
      assert.ok(cols.includes('current_waypoint_idx'), 'current_waypoint_idx column added');
      assert.ok(cols.includes('spray_results_json'), 'spray_results_json column added');
      assert.ok(cols.includes('updated_at'), 'updated_at column added');

      // New statuses accepted by the widened CHECK constraint.
      assert.doesNotThrow(() => {
        result.db.prepare("INSERT INTO mission (started_at, status, waypoints_json) VALUES (?, 'interrupted', '[]')")
          .run(Date.now());
        result.db.prepare("INSERT INTO mission (started_at, status, waypoints_json) VALUES (?, 'paused', '[]')")
          .run(Date.now());
      });
    } finally {
      await stopServer(started.server);
      result.db.close();
      cleanup(p);
    }
  });
});

describe('Cone schema migration (center + alt ordering)', () => {
  it('migrates a pre-center, pre-alt cone table without a column-count crash', async () => {
    // Regression guard: the alt ADD COLUMN migration runs before the 'center'
    // CHECK-constraint rebuild, so at rebuild time cone has 8 columns. If that
    // rebuild copied via `INSERT INTO cone_new SELECT *` into a 7-column
    // cone_new (no alt), the startup transaction would throw "7 columns but 8
    // values were supplied" and the service would not boot.
    const Database = db.constructor;
    const p = tmpDbPath();
    const raw = new Database(p);
    raw.pragma("foreign_keys = ON");
    raw.exec(`CREATE TABLE course (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);
    raw.prepare("INSERT INTO course (name) VALUES (?)").run('legacy-course');
    // OLD schema: no alt column, CHECK without 'center'.
    raw.exec(`CREATE TABLE cone (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('left', 'right')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
    )`);
    raw.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (1, ?, ?, 'left')").run(37.5, 126.9);
    raw.close();

    // Opening the app runs the migrations — this is the step that crashed.
    const { createCourseApp } = await import('../../course/index.mjs?v=conemigrate');
    let result;
    assert.doesNotThrow(() => { result = createCourseApp({ dbPath: p, validateUser: TRUST_JWT }); }, 'app must boot on a pre-center, pre-alt cone DB');
    try {
      // Legacy cone row preserved through the rebuild; alt defaulted to null.
      const row = result.db.prepare("SELECT * FROM cone WHERE id = 1").get();
      assert.equal(row.side, 'left');
      assert.equal(row.lat, 37.5);
      assert.equal(row.alt, null, 'alt column present and null for the legacy row');
      // Widened CHECK now accepts 'center'.
      assert.doesNotThrow(() => {
        result.db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (1, ?, ?, 'center')").run(37.6, 126.8);
      });
    } finally {
      result.db.close();
      cleanup(p);
    }
  });
});
