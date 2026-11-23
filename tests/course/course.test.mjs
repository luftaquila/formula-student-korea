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
  TEST_INTERNAL_SECRET,
  waitForCondition,
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

// ─── Courses ────────────────────────────────────────────────────────────
describe('GET /api/courses (initial)', () => {
  it('returns empty array', async () => {
    const res = await client.get('/api/courses', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });
});

describe('POST /api/courses', () => {
  it('creates a course', async () => {
    const res = await client.post('/api/courses', {
      body: { name: '오토크로스 A' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, '오토크로스 A');
    assert.ok(data.id);
  });

  it('rejects empty name', async () => {
    const res = await client.post('/api/courses', {
      body: { name: '' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects duplicate name', async () => {
    const res = await client.post('/api/courses', {
      body: { name: '오토크로스 A' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('creates a second course', async () => {
    const res = await client.post('/api/courses', {
      body: { name: '스키드패드 B' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).name, '스키드패드 B');
  });
});

describe('GET /api/courses (after create)', () => {
  it('returns created courses with cone_count', async () => {
    const res = await client.get('/api/courses', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    assert.equal(data[0].name, '오토크로스 A');
    assert.equal(data[1].name, '스키드패드 B');
    assert.equal(data[0].cone_count, 0);
  });
});

describe('PATCH /api/courses/:id', () => {
  it('renames a course', async () => {
    const res = await client.patch('/api/courses/1', {
      body: { name: '오토크로스 A-1' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, '오토크로스 A-1');
  });

  it('rejects empty name', async () => {
    const res = await client.patch('/api/courses/1', {
      body: { name: '  ' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.patch('/api/courses/999', {
      body: { name: 'test' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('rejects duplicate name on rename', async () => {
    const res = await client.patch('/api/courses/2', {
      body: { name: '오토크로스 A-1' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Cones ──────────────────────────────────────────────────────────────
describe('POST /api/courses/:id/cones', () => {
  it('adds a cone to a course', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5665, lng: 126.978, side: 'left' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.course_id, 1);
    assert.equal(data.lat, 37.5665);
    assert.equal(data.lng, 126.978);
    assert.equal(data.side, 'left');
    assert.equal(data.alt, null); // alt omitted → stored null (manual/map-click cone)
  });

  it('adds a right cone with altitude', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5666, lng: 126.9781, side: 'right', alt: 42.5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.alt, 42.5); // RTK MSL altitude persisted alongside lat/lng
  });

  it('adds a center cone', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5667, lng: 126.9782, side: 'center' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.side, 'center');
  });

  it('rejects invalid latitude', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 91, lng: 126.978, side: 'left' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid longitude', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5, lng: 181, side: 'left' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid side', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5, lng: 126.9, side: 'invalid' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects out-of-range altitude', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5, lng: 126.9, side: 'left', alt: 999999 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-numeric altitude', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5, lng: 126.9, side: 'left', alt: 'high' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.post('/api/courses/999/cones', {
      body: { lat: 37.5, lng: 126.9, side: 'left' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/courses/:id/cones', () => {
  it('returns cones for a course', async () => {
    const res = await client.get('/api/courses/1/cones', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 3);
    assert.equal(data[0].side, 'left');
    assert.equal(data[1].side, 'right');
    assert.equal(data[2].side, 'center');
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.get('/api/courses/999/cones', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('PATCH /api/cones/:id', () => {
  it('updates cone position', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { lat: 37.5670, lng: 126.9785 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.lat, 37.567);
    assert.equal(data.lng, 126.9785);
  });

  it('updates cone side', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { side: 'right' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.side, 'right');
  });

  it('updates cone altitude', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { alt: 12.34 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.alt, 12.34);
  });

  it('preserves altitude when patching only lat/lng', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { lat: 37.568 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.lat, 37.568);
    assert.equal(data.alt, 12.34); // alt untouched by a lat-only PATCH
  });

  it('rejects invalid coordinate', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { lat: -91 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid altitude', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { alt: 'high' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid side', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { side: 'invalid' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty update', async () => {
    const res = await client.patch('/api/cones/1', {
      body: {},
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent cone', async () => {
    const res = await client.patch('/api/cones/999', {
      body: { lat: 37.5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/cones/:id', () => {
  it('deletes a cone', async () => {
    const res = await client.delete('/api/cones/2', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const cones = await (await client.get('/api/courses/1/cones', { cookie: adminCookie })).json();
    assert.equal(cones.length, 2);
  });

  it('returns 404 for already deleted cone', async () => {
    const res = await client.delete('/api/cones/2', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

});

// ─── Ordered route markers ─────────────────────────────────────────────
describe('course ordered route markers', () => {
  let firstId, secondId, otherCourseMarkerId;

  it('starts empty and creates physical markers without implicit visits', async () => {
    let res = await client.get('/api/courses/1/route', { cookie: adminCookie });
    assert.deepEqual(await res.json(), { markers: [], steps: [] });

    res = await client.post('/api/courses/1/route/markers', {
      body: { lat: 35.292, lng: 126.574, label: '허리' }, cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    firstId = (await res.json()).id;
    res = await client.post('/api/courses/1/route/markers', {
      body: { lat: 35.293, lng: 126.575, label: '좌측' }, cookie: adminCookie,
    });
    secondId = (await res.json()).id;
    const route = await (await client.get('/api/courses/1/route', { cookie: adminCookie })).json();
    assert.equal(route.markers.length, 2);
    assert.deepEqual(route.steps, []);
  });

  it('stores a visit sequence with repeated references to one marker', async () => {
    const res = await client.put('/api/courses/1/route/steps', {
      body: { steps: [firstId, secondId, firstId] }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).steps, [firstId, secondId, firstId]);
  });

  it('updates marker metadata and rejects another course marker in the route', async () => {
    let res = await client.patch(`/api/route/markers/${secondId}`, {
      body: { label: '좌측 원', lat: 35.2931 }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).label, '좌측 원');

    res = await client.post('/api/courses/2/route/markers', {
      body: { lat: 35.4, lng: 126.6, label: '다른 코스' }, cookie: adminCookie,
    });
    otherCourseMarkerId = (await res.json()).id;
    res = await client.put('/api/courses/1/route/steps', {
      body: { steps: [firstId, otherCourseMarkerId] }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
    const unchanged = await (await client.get('/api/courses/1/route', { cookie: adminCookie })).json();
    assert.deepEqual(unchanged.steps, [firstId, secondId, firstId]);
  });

  it('exports markers by array index so repeated visits survive id reassignment', async () => {
    const data = await (await client.get('/api/courses/1/export', { cookie: adminCookie })).json();
    assert.deepEqual(data.route_steps, [0, 1, 0]);
    assert.deepEqual(data.route_markers.map((m) => m.label), ['허리', '좌측 원']);
  });

  it('deleting a marker removes every visit and compacts the remaining order', async () => {
    const res = await client.delete(`/api/route/markers/${firstId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const route = await res.json();
    assert.deepEqual(route.steps, [secondId]);
    assert.deepEqual(route.markers.map((m) => m.id), [secondId]);
  });

  it('requires an existing course and valid marker input', async () => {
    let res = await client.get('/api/courses/999/route', { cookie: adminCookie });
    assert.equal(res.status, 404);
    res = await client.post('/api/courses/1/route/markers', {
      body: { lat: 999, lng: 126.5, label: 'bad' }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
    res = await client.put('/api/courses/1/route/steps', {
      body: { steps: ['not-an-id'] }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('keeps the original SQLite cause in guided-route failure logs', async () => {
    db.exec(`CREATE TEMP TRIGGER fail_route_marker_insert
      BEFORE INSERT ON route_marker
      BEGIN SELECT RAISE(ABORT, 'injected route storage failure'); END`);
    try {
      const res = await client.post('/api/courses/1/route/markers', {
        body: { lat: 35.294, lng: 126.576, label: '실패 주입' }, cookie: adminCookie,
      });
      assert.equal(res.status, 500);
      assert.equal(await res.text(), 'Server error.');
      const warning = db.prepare(`SELECT detail FROM logs
        WHERE action = 'route_marker.create' AND target = '오토크로스 A-1'
        ORDER BY id DESC LIMIT 1`).get();
      assert.equal(JSON.parse(warning.detail).error, 'injected route storage failure');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_route_marker_insert');
    }
  });
});

// ─── Cascade Delete ─────────────────────────────────────────────────────
describe('DELETE /api/courses/:id (cascade)', () => {
  it('deleting course cascades to cones', async () => {
    // Add a cone to course 2
    await client.post('/api/courses/2/cones', {
      body: { lat: 35.0, lng: 129.0, side: 'left' },
      cookie: adminCookie,
    });

    const res = await client.delete('/api/courses/2', { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Cone should be gone (course 2 no longer exists)
    const conesRes = await client.get('/api/courses/2/cones', { cookie: adminCookie });
    assert.equal(conesRes.status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM route_marker WHERE course_id = 2').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM route_step WHERE course_id = 2').get().n, 0);
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.delete('/api/courses/999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/courses/:id (remaining)', () => {
  it('deletes remaining course, audits the cascade, and detaches retired missions', async () => {
    const coneId = db.prepare('SELECT id FROM cone WHERE course_id = 1 ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO memo (course_id, lat, lng, width, height, content)
      VALUES (1, 35, 126, 2, 1, 'delete audit')`).run();
    db.prepare(`INSERT INTO course_snapshot (course_id, taken_at, reason, cones_json)
      VALUES (1, ?, 'delete audit', '[]')`).run(Date.now());
    const presetId = Number(db.prepare(`INSERT INTO mission_route_preset
      (course_id, name, finish_behavior, created_at, updated_at)
      VALUES (1, 'delete audit preset', 'stop', ?, ?)`).run(Date.now(), Date.now()).lastInsertRowid);
    db.prepare(`INSERT INTO mission_route_preset_item
      (id, preset_id, position, cone_id, cone_id_snapshot, lat_snapshot, lng_snapshot, side_snapshot)
      VALUES ('delete-audit-item', ?, 0, ?, ?, 35, 126, 'left')`).run(presetId, coneId, coneId);
    const missionId = Number(db.prepare(`INSERT INTO mission
      (course_id, started_at, ended_at, status, waypoints_json, lifecycle_state)
      VALUES (1, ?, ?, 'completed', '[]', 'completed')`).run(Date.now() - 1, Date.now()).lastInsertRowid);
    db.prepare(`INSERT INTO mission_waypoint
      (id, mission_id, position, cone_id, cone_id_snapshot, lat, lng, side, state, created_at, updated_at)
      VALUES ('delete-audit-waypoint', ?, 0, ?, ?, 35, 126, 'left', 'completed', ?, ?)`)
      .run(missionId, coneId, coneId, Date.now(), Date.now());
    const count = (table, where = 'course_id = 1') =>
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

    const res = await client.delete('/api/courses/1', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const courses = await (await client.get('/api/courses', { cookie: adminCookie })).json();
    assert.deepEqual(courses, []);
    assert.equal(db.prepare('SELECT course_id FROM mission WHERE id = ?').get(missionId).course_id, null);
    assert.equal(
      db.prepare("SELECT cone_id FROM mission_waypoint WHERE id = 'delete-audit-waypoint'").get().cone_id,
      null,
    );
    const audit = db.prepare(`SELECT detail FROM logs
      WHERE action = 'course.delete' AND target = '오토크로스 A-1'
      ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual(JSON.parse(audit.detail), { course_id: 1, cascade: expectedCascade });
  });
});

// ─── Export / Import ────────────────────────────────────────────────────
describe('GET /api/courses/:id/export', () => {
  before(async () => {
    await client.post('/api/courses', { body: { name: 'export-test' }, cookie: adminCookie });
    await client.post('/api/courses/3/cones', { body: { lat: 35.0, lng: 126.0, side: 'left', alt: 88.8 }, cookie: adminCookie });
  });

  it('exports course as JSON', async () => {
    const res = await client.get('/api/courses/3/export', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'export-test');
    assert.equal(data.cones.length, 1);
    assert.equal(data.cones[0].lat, 35.0);
    assert.equal(data.cones[0].side, 'left');
    assert.equal(data.cones[0].alt, 88.8); // altitude included in export
    assert.equal(data.reverse, false);         // default forward
    assert.equal(data.start_cone_index, null); // no start cone designated
  });

  it('exports the travel direction and start cone (by array index)', async () => {
    const cones = await (await client.get('/api/courses/3/cones', { cookie: adminCookie })).json();
    await client.patch('/api/courses/3/direction', {
      body: { reverse: true, start_cone_id: cones[0].id }, cookie: adminCookie,
    });
    const data = await (await client.get('/api/courses/3/export', { cookie: adminCookie })).json();
    assert.equal(data.reverse, true);
    assert.equal(data.start_cone_index, 0); // cone ids are reassigned on import → export by position
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.get('/api/courses/999/export', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  after(async () => {
    await client.delete('/api/courses/3', { cookie: adminCookie });
  });
});

describe('POST /api/courses/import', () => {
  it('imports course from JSON', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'imported-course', cones: [{ lat: 35.1, lng: 126.1, side: 'right' }, { lat: 35.2, lng: 126.2, side: 'center' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'imported-course');
  });

  it('rejects duplicate name', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'imported-course', cones: [] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid cone data', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'bad-import', cones: [{ lat: 91, lng: 0, side: 'left' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('imports cone altitude and persists it', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'alt-import', cones: [{ lat: 35.3, lng: 126.3, side: 'left', alt: 55.5 }, { lat: 35.4, lng: 126.4, side: 'right' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const course = await res.json();
    const conesRes = await client.get(`/api/courses/${course.id}/cones`, { cookie: adminCookie });
    const cones = await conesRes.json();
    assert.equal(cones.length, 2);
    assert.equal(cones[0].alt, 55.5); // alt preserved through import
    assert.equal(cones[1].alt, null); // cone without alt → null
  });

  it('round-trips reusable route markers and repeated visit indices', async () => {
    const res = await client.post('/api/courses/import', {
      body: {
        name: 'guided-import',
        cones: [],
        route_markers: [
          { lat: 35.1, lng: 126.1, label: '허리' },
          { lat: 35.2, lng: 126.2, label: '원 외곽' },
        ],
        route_steps: [0, 1, 0, 1, 0],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const course = await res.json();
    const route = await (await client.get(`/api/courses/${course.id}/route`, { cookie: adminCookie })).json();
    assert.equal(route.markers.length, 2);
    assert.deepEqual(route.steps, [route.markers[0].id, route.markers[1].id, route.markers[0].id, route.markers[1].id, route.markers[0].id]);
    const exported = await (await client.get(`/api/courses/${course.id}/export`, { cookie: adminCookie })).json();
    assert.deepEqual(exported.route_steps, [0, 1, 0, 1, 0]);
  });

  it('logs route validation failures with structured error detail', async () => {
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

  it('rejects import with invalid altitude', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'bad-alt-import', cones: [{ lat: 35.0, lng: 126.0, side: 'left', alt: 'high' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('restores travel direction and start cone from an export', async () => {
    const res = await client.post('/api/courses/import', {
      body: {
        name: 'dir-import',
        reverse: true,
        start_cone_index: 1,
        cones: [{ lat: 35.5, lng: 126.5, side: 'left' }, { lat: 35.6, lng: 126.6, side: 'right' }],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const course = await res.json();
    assert.equal(course.reverse, 1); // stored 0/1
    const cones = await (await client.get(`/api/courses/${course.id}/cones`, { cookie: adminCookie })).json();
    assert.equal(course.start_cone_id, cones[1].id); // index 1 → 2nd inserted cone's new id
  });

  it('defaults to forward / no start when direction fields are absent', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'nodir-import', cones: [{ lat: 35.7, lng: 126.7, side: 'left' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const course = await res.json();
    assert.equal(course.reverse, 0);
    assert.equal(course.start_cone_id, null);
  });

  it('ignores an out-of-range start_cone_index (leaves start unset)', async () => {
    const res = await client.post('/api/courses/import', {
      body: { name: 'oob-import', start_cone_index: 9, cones: [{ lat: 35.8, lng: 126.8, side: 'left' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const course = await res.json();
    assert.equal(course.start_cone_id, null);
  });

  after(async () => {
    // cleanup
    const res = await client.get('/api/courses', { cookie: adminCookie });
    const courses = await res.json();
    for (const c of courses) {
      await client.delete(`/api/courses/${c.id}`, { cookie: adminCookie });
    }
  });
});

// ─── Course direction / start cone (server-shared) ───────────────────────
describe('PATCH /api/courses/:id/direction', () => {
  let courseId, coneId, otherCourseId, otherConeId;

  before(async () => {
    const cRes = await client.post('/api/courses', {
      body: { name: '방향테스트 코스' }, cookie: adminCookie,
    });
    courseId = (await cRes.json()).id;
    const coneRes = await client.post(`/api/courses/${courseId}/cones`, {
      body: { lat: 37.6, lng: 126.99, side: 'left' }, cookie: adminCookie,
    });
    coneId = (await coneRes.json()).id;

    const oRes = await client.post('/api/courses', {
      body: { name: '방향테스트 다른 코스' }, cookie: adminCookie,
    });
    otherCourseId = (await oRes.json()).id;
    const oConeRes = await client.post(`/api/courses/${otherCourseId}/cones`, {
      body: { lat: 37.7, lng: 126.9, side: 'right' }, cookie: adminCookie,
    });
    otherConeId = (await oConeRes.json()).id;
  });

  it('defaults to forward (reverse 0) and no start cone', async () => {
    const res = await client.get('/api/courses', { cookie: adminCookie });
    const course = (await res.json()).find((c) => c.id === courseId);
    assert.equal(course.reverse, 0);
    assert.equal(course.start_cone_id, null);
  });

  it('sets and clears the travel direction', async () => {
    let res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: true }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reverse, 1); // 0/1: SQLite has no boolean type

    res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: false }, cookie: adminCookie,
    });
    assert.equal((await res.json()).reverse, 0);
  });

  it('rejects a non-boolean reverse', async () => {
    const res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: 'yes' }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('sets and clears the start cone', async () => {
    let res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { start_cone_id: coneId }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).start_cone_id, coneId);

    res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { start_cone_id: null }, cookie: adminCookie,
    });
    assert.equal((await res.json()).start_cone_id, null);
  });

  it('rejects a start cone from another course', async () => {
    const res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { start_cone_id: otherConeId }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects a non-integer start cone id', async () => {
    const res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { start_cone_id: 'abc' }, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('updates reverse and start_cone_id together', async () => {
    const res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: true, start_cone_id: coneId }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reverse, 1);
    assert.equal(data.start_cone_id, coneId);
  });

  it('rejects an empty body (nothing to update)', async () => {
    const res = await client.patch(`/api/courses/${courseId}/direction`, {
      body: {}, cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for a non-existent course', async () => {
    const res = await client.patch('/api/courses/999999/direction', {
      body: { reverse: true }, cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('allows course operation but rejects an unrelated grant', async () => {
    const editorCookie = makeAuthCookie({
      email: 'course-editor@test.com', name: 'Course editor', role: 'official', permissions: ['course.operate'],
    });
    const otherCookie = makeAuthCookie({
      email: 'queue-operator@test.com', name: 'Queue operator', role: 'official', permissions: ['queue.operate'],
    });
    const editorRes = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: false }, cookie: editorCookie,
    });
    assert.equal(editorRes.status, 200);
    const otherRes = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: true }, cookie: otherCookie,
    });
    assert.equal(otherRes.status, 403);
  });
});

// ─── start_cone_id dangling cleanup ──────────────────────────────────────
describe('start_cone_id dangling cleanup', () => {
  let courseId, coneIds;
  const startOf = async (id) =>
    (await (await client.get('/api/courses', { cookie: adminCookie })).json())
      .find((c) => c.id === id)?.start_cone_id;

  before(async () => {
    const cRes = await client.post('/api/courses', { body: { name: '시작콘정리 코스' }, cookie: adminCookie });
    courseId = (await cRes.json()).id;
    coneIds = [];
    for (const c of [{ lat: 37.1, lng: 126.1, side: 'left' }, { lat: 37.2, lng: 126.2, side: 'right' }]) {
      const r = await client.post(`/api/courses/${courseId}/cones`, { body: c, cookie: adminCookie });
      coneIds.push((await r.json()).id);
    }
  });

  it('clears start_cone_id when the designated start cone is deleted', async () => {
    await client.patch(`/api/courses/${courseId}/direction`, { body: { start_cone_id: coneIds[0] }, cookie: adminCookie });
    assert.equal(await startOf(courseId), coneIds[0]);
    await client.delete(`/api/cones/${coneIds[0]}`, { cookie: adminCookie });
    assert.equal(await startOf(courseId), null); // no longer dangles at the deleted cone
  });

  it('leaves start_cone_id intact when a non-start cone is deleted', async () => {
    const r = await client.post(`/api/courses/${courseId}/cones`, { body: { lat: 37.3, lng: 126.3, side: 'center' }, cookie: adminCookie });
    const thirdId = (await r.json()).id;
    await client.patch(`/api/courses/${courseId}/direction`, { body: { start_cone_id: coneIds[1] }, cookie: adminCookie });
    await client.delete(`/api/cones/${thirdId}`, { cookie: adminCookie });
    assert.equal(await startOf(courseId), coneIds[1]);
  });

  it('clears start_cone_id on snapshot restore (cones get fresh ids)', async () => {
    await client.patch(`/api/courses/${courseId}/direction`, { body: { start_cone_id: coneIds[1] }, cookie: adminCookie });
    const snap = await (await client.post(`/api/courses/${courseId}/snapshots`, { body: { reason: 'test' }, cookie: adminCookie })).json();
    const restoreRes = await client.post(`/api/courses/${courseId}/snapshots/${snap.id}/restore`, { cookie: adminCookie });
    assert.equal(restoreRes.status, 200);
    assert.equal(await startOf(courseId), null);
  });

  after(async () => {
    await client.delete(`/api/courses/${courseId}`, { cookie: adminCookie });
  });
});

// ─── Bulk cone delete (전체 삭제) ──────────────────────────────────────────
describe('DELETE /api/courses/:id/cones (delete all)', () => {
  let courseId, coneIds;
  const masterCookie = makeAuthCookie({ email: 'master@test.com', name: 'Master', role: 'master' });
  const startOf = async (id) =>
    (await (await client.get('/api/courses', { cookie: adminCookie })).json())
      .find((c) => c.id === id)?.start_cone_id;

  before(async () => {
    const cRes = await client.post('/api/courses', { body: { name: '전체삭제 코스' }, cookie: adminCookie });
    courseId = (await cRes.json()).id;
    coneIds = [];
    for (const c of [
      { lat: 37.1, lng: 126.1, side: 'left' },
      { lat: 37.2, lng: 126.2, side: 'right' },
      { lat: 37.3, lng: 126.3, side: 'center' },
    ]) {
      const r = await client.post(`/api/courses/${courseId}/cones`, { body: c, cookie: adminCookie });
      coneIds.push((await r.json()).id);
    }
  });

  it('returns 404 for a non-existent course', async () => {
    const res = await client.delete('/api/courses/999999/cones', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('is allowed for master (parity with per-cone delete)', async () => {
    // Throwaway course so the main course's cones survive for the next test.
    const tmpId = (await (await client.post('/api/courses', { body: { name: '전체삭제 master' }, cookie: adminCookie })).json()).id;
    await client.post(`/api/courses/${tmpId}/cones`, { body: { lat: 37.0, lng: 126.0, side: 'left' }, cookie: adminCookie });
    const res = await client.delete(`/api/courses/${tmpId}/cones`, { cookie: masterCookie });
    assert.equal(res.status, 200);
    await client.delete(`/api/courses/${tmpId}`, { cookie: adminCookie });
  });

  it('deletes every cone and clears the designated start cone', async () => {
    await client.patch(`/api/courses/${courseId}/direction`, { body: { start_cone_id: coneIds[0] }, cookie: adminCookie });
    assert.equal(await startOf(courseId), coneIds[0]);

    const res = await client.delete(`/api/courses/${courseId}/cones`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 3);

    const cones = await (await client.get(`/api/courses/${courseId}/cones`, { cookie: adminCookie })).json();
    assert.equal(cones.length, 0);
    assert.equal(await startOf(courseId), null); // start cone no longer dangles
  });

  it('is a 200 no-op when the course already has no cones', async () => {
    const res = await client.delete(`/api/courses/${courseId}/cones`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 0);
  });

  after(async () => {
    await client.delete(`/api/courses/${courseId}`, { cookie: adminCookie });
  });
});

// ─── Rover ──────────────────────────────────────────────────────────────
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

describe('Course snapshots', () => {
  const masterCookie = makeAuthCookie({ email: 'master-snap@test.com', name: 'Master', role: 'master' });
  let courseId;

  before(async () => {
    const c = await client.post('/api/courses', { body: { name: '스냅샷 테스트 코스' }, cookie: adminCookie });
    courseId = (await c.json()).id;
    await client.post(`/api/courses/${courseId}/cones`, { body: { lat: 35.1, lng: 126.1, side: 'left' }, cookie: adminCookie });
    await client.post(`/api/courses/${courseId}/cones`, { body: { lat: 35.2, lng: 126.2, side: 'right' }, cookie: adminCookie });
  });

  it('lets master take a snapshot but not list, restore, or delete them', async () => {
    assert.equal((await client.get(`/api/courses/${courseId}/snapshots`, { cookie: masterCookie })).status, 403);
    // A missing course proves the permission gate passed without adding a snapshot.
    assert.equal((await client.post('/api/courses/99999/snapshots', { body: { reason: 'x' }, cookie: masterCookie })).status, 404);
    assert.equal((await client.post(`/api/courses/${courseId}/snapshots/1/restore`, { cookie: masterCookie })).status, 403);
    assert.equal((await client.delete(`/api/courses/${courseId}/snapshots/1`, { cookie: masterCookie })).status, 403);
  });

  it('lets admin create, list, restore, and delete a snapshot', async () => {
    const res = await client.post(`/api/courses/${courseId}/snapshots`, { body: { reason: 'first' }, cookie: adminCookie });
    assert.equal(res.status, 201);
    const snapshotId = (await res.json()).id;
    assert.ok(snapshotId);

    const list = await client.get(`/api/courses/${courseId}/snapshots`, { cookie: adminCookie });
    assert.equal(list.status, 200);
    let { snapshots } = await list.json();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].cone_count, 2);
    assert.equal(snapshots[0].reason, 'first');

    const add = await client.post(`/api/courses/${courseId}/cones`, {
      body: { lat: 35.3, lng: 126.3, side: 'left' },
      cookie: adminCookie,
    });
    assert.equal(add.status, 201);

    const restore = await client.post(`/api/courses/${courseId}/snapshots/${snapshotId}/restore`, { cookie: adminCookie });
    assert.equal(restore.status, 200);
    const { cones } = await restore.json();
    assert.equal(cones.length, 2);

    ({ snapshots } = await (await client.get(`/api/courses/${courseId}/snapshots`, { cookie: adminCookie })).json());
    assert.equal(snapshots.length, 2);

    const del = await client.delete(`/api/courses/${courseId}/snapshots/${snapshotId}`, { cookie: adminCookie });
    assert.equal(del.status, 204);
    ({ snapshots } = await (await client.get(`/api/courses/${courseId}/snapshots`, { cookie: adminCookie })).json());
    assert.equal(snapshots.length, 1);
    assert.ok(!snapshots.some((s) => s.id === snapshotId));
  });

  it('rejects snapshotting a course with no cones', async () => {
    const empty = await client.post('/api/courses', { body: { name: '빈 코스' }, cookie: adminCookie });
    const emptyId = (await empty.json()).id;
    const res = await client.post(`/api/courses/${emptyId}/snapshots`, { body: {}, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('returns 404 restoring a non-existent snapshot', async () => {
    const res = await client.post(`/api/courses/${courseId}/snapshots/999999/restore`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('returns 404 deleting a non-existent snapshot', async () => {
    const res = await client.delete(`/api/courses/${courseId}/snapshots/999999`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('returns 404 deleting a snapshot that belongs to another course', async () => {
    const created = await client.post(`/api/courses/${courseId}/snapshots`, {
      body: { reason: 'ownership-check' },
      cookie: adminCookie,
    });
    assert.equal(created.status, 201);
    const snapshotId = (await created.json()).id;
    const other = await client.post('/api/courses', { body: { name: '다른 스냅샷 코스' }, cookie: adminCookie });
    const otherId = (await other.json()).id;
    const res = await client.delete(`/api/courses/${otherId}/snapshots/${snapshotId}`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Memo stickers ──────────────────────────────────────────────────────
describe('Memo stickers', () => {
  let memoCourseId;
  let memoId;

  before(async () => {
    const res = await client.post('/api/courses', { body: { name: '메모 테스트 코스' }, cookie: adminCookie });
    memoCourseId = (await res.json()).id;
  });

  it('creates a memo with center coordinate, size and content', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 25, height: 12, content: '슬라럼 구간' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.course_id, memoCourseId);
    assert.equal(data.lat, 37.5);
    assert.equal(data.lng, 126.9);
    assert.equal(data.width, 25);
    assert.equal(data.height, 12);
    assert.equal(data.content, '슬라럼 구간');
    memoId = data.id;
  });

  it('defaults content to empty string when omitted', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.51, lng: 126.91, width: 10, height: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.content, '');
  });

  it('lists memos for a course', async () => {
    const res = await client.get(`/api/courses/${memoCourseId}/memos`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    assert.equal(data[0].content, '슬라럼 구간');
  });

  it('rejects invalid coordinates', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 91, lng: 126.9, width: 10, height: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-positive or non-finite dimensions', async () => {
    for (const bad of [{ width: 0, height: 10 }, { width: 10, height: -5 }, { width: 'big', height: 10 }, { width: 10, height: 200000 }]) {
      const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
        body: { lat: 37.5, lng: 126.9, ...bad },
        cookie: adminCookie,
      });
      assert.equal(res.status, 400);
    }
  });

  it('rejects over-long content', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10, content: 'x'.repeat(5001) },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 creating a memo on a non-existent course', async () => {
    const res = await client.post('/api/courses/999999/memos', {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('updates memo position (drag)', async () => {
    const res = await client.patch(`/api/memos/${memoId}`, {
      body: { lat: 37.6, lng: 127.0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.lat, 37.6);
    assert.equal(data.lng, 127.0);
  });

  it('updates memo size (resize)', async () => {
    const res = await client.patch(`/api/memos/${memoId}`, {
      body: { width: 40, height: 30 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.width, 40);
    assert.equal(data.height, 30);
  });

  it('updates memo content (edit)', async () => {
    const res = await client.patch(`/api/memos/${memoId}`, {
      body: { content: '수정된 내용' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.content, '수정된 내용');
  });

  it('defaults rotation to 0 when omitted', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).rotation, 0);
  });

  it('creates and updates rotation, normalizing to [0,360)', async () => {
    const create = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10, rotation: 45 },
      cookie: adminCookie,
    });
    assert.equal((await create.json()).rotation, 45);
    const res = await client.patch(`/api/memos/${memoId}`, {
      body: { rotation: 405 }, // 405 → 45
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rotation, 45);
  });

  it('rejects a non-finite rotation', async () => {
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10, rotation: 'sideways' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects a patch with no editable fields', async () => {
    const res = await client.patch(`/api/memos/${memoId}`, { body: {}, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('rejects an invalid dimension on update', async () => {
    const res = await client.patch(`/api/memos/${memoId}`, { body: { width: -1 }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('returns 404 updating a non-existent memo', async () => {
    const res = await client.patch('/api/memos/999999', { body: { content: 'x' }, cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('deletes a memo', async () => {
    const res = await client.delete(`/api/memos/${memoId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const list = await (await client.get(`/api/courses/${memoCourseId}/memos`, { cookie: adminCookie })).json();
    assert.ok(!list.some((m) => m.id === memoId));
  });

  it('returns 404 deleting a non-existent memo', async () => {
    const res = await client.delete('/api/memos/999999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('allows master to manage memos (course-level annotation)', async () => {
    const masterCookie = makeAuthCookie({ email: 'master2@test.com', name: 'Master2', role: 'master' });
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: masterCookie,
    });
    assert.equal(res.status, 201);
  });

  it('rejects below-master roles from memo management', async () => {
    const chiefCookie = makeAuthCookie({ email: 'chief2@test.com', name: 'Chief2', role: 'chief' });
    const list = await client.get(`/api/courses/${memoCourseId}/memos`, { cookie: chiefCookie });
    assert.equal(list.status, 403);
    const create = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: chiefCookie,
    });
    assert.equal(create.status, 403);
  });

  it('cascade-deletes memos when the course is deleted', async () => {
    const c = await client.post('/api/courses', { body: { name: '메모 캐스케이드' }, cookie: adminCookie });
    const cid = (await c.json()).id;
    const m = await client.post(`/api/courses/${cid}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10, content: 'cascade' },
      cookie: adminCookie,
    });
    const mid = (await m.json()).id;
    await client.delete(`/api/courses/${cid}`, { cookie: adminCookie });
    const res = await client.patch(`/api/memos/${mid}`, { body: { content: 'x' }, cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('round-trips memos through export → import', async () => {
    const c = await client.post('/api/courses', { body: { name: '메모 왕복' }, cookie: adminCookie });
    const cid = (await c.json()).id;
    await client.post(`/api/courses/${cid}/cones`, { body: { lat: 35, lng: 126, side: 'left' }, cookie: adminCookie });
    await client.post(`/api/courses/${cid}/memos`, {
      body: { lat: 35.1, lng: 126.1, width: 20, height: 8, rotation: 30, content: '왕복 라벨' },
      cookie: adminCookie,
    });
    // export includes memos
    const exp = await (await client.get(`/api/courses/${cid}/export`, { cookie: adminCookie })).json();
    assert.equal(exp.memos.length, 1);
    assert.equal(exp.memos[0].content, '왕복 라벨');
    assert.equal(exp.memos[0].rotation, 30);
    // import restores them onto a new course
    const imp = await client.post('/api/courses/import', { body: { ...exp, name: '메모 왕복 2' }, cookie: adminCookie });
    assert.equal(imp.status, 201);
    const newId = (await imp.json()).id;
    const memos = await (await client.get(`/api/courses/${newId}/memos`, { cookie: adminCookie })).json();
    assert.equal(memos.length, 1);
    assert.equal(memos[0].content, '왕복 라벨');
    assert.equal(memos[0].rotation, 30);
    assert.equal(memos[0].width, 20);
    assert.equal(memos[0].height, 8);
  });
});
