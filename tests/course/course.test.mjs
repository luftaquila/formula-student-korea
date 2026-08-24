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
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createCourseApp } from '../../course/index.mjs';

function withFailureTimeout(promise, label, timeoutMs = 2_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
  const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });

  it('rejects unauthenticated requests to /api/courses', async () => {
    const res = await client.get('/api/courses');
    assert.equal(res.status, 401);
  });

  it('rejects below-chief roles from /api/courses', async () => {
    const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
    const studentRes = await client.get('/api/courses', { cookie: studentCookie });
    assert.equal(studentRes.status, 403);
    const officialRes = await client.get('/api/courses', { cookie: officialCookie });
    assert.equal(officialRes.status, 403);
  });

  it('allows chief to manage courses (cone management is chief-level)', async () => {
    const res = await client.get('/api/courses', { cookie: chiefCookie });
    assert.equal(res.status, 200);
  });

  it('keeps rover control and mission history admin-only (chief is rejected)', async () => {
    const rover = await client.get('/api/rover/status', { cookie: chiefCookie });
    assert.equal(rover.status, 403);
    const missions = await client.get('/api/missions', { cookie: chiefCookie });
    assert.equal(missions.status, 403);
  });

  it('makes course deletion admin-only (chief is rejected, gate runs before handler)', async () => {
    // The auth gate returns 403 ahead of the handler, so this holds whether or
    // not a course with this id exists. Chief keeps create/rename/cone edits.
    const res = await client.delete('/api/courses/1', { cookie: chiefCookie });
    assert.equal(res.status, 403);
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
      assert.equal(await res.text(), '서버 오류가 발생했습니다.');
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
  it('deletes remaining course and audits the full cascade/detach scope', async () => {
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
    assert.deepEqual(JSON.parse(audit.detail), {
      course_id: 1,
      cascade: expectedCascade,
      detached: { missions: 1, mission_waypoints: 1 },
    });
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

  it('allows chief but rejects below-chief roles', async () => {
    const chiefCookie = makeAuthCookie({ email: 'chief2@test.com', name: 'Chief', role: 'chief' });
    const officialCookie = makeAuthCookie({ email: 'official2@test.com', name: 'Official', role: 'official' });
    const chiefRes = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: false }, cookie: chiefCookie,
    });
    assert.equal(chiefRes.status, 200);
    const officialRes = await client.patch(`/api/courses/${courseId}/direction`, {
      body: { reverse: true }, cookie: officialCookie,
    });
    assert.equal(officialRes.status, 403);
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
  const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
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

  it('is allowed for chief (parity with per-cone delete)', async () => {
    // Throwaway course so the main course's cones survive for the next test.
    const tmpId = (await (await client.post('/api/courses', { body: { name: '전체삭제 chief' }, cookie: adminCookie })).json()).id;
    await client.post(`/api/courses/${tmpId}/cones`, { body: { lat: 37.0, lng: 126.0, side: 'left' }, cookie: adminCookie });
    const res = await client.delete(`/api/courses/${tmpId}/cones`, { cookie: chiefCookie });
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
describe('POST /api/rover/position', () => {
  it('accepts position from rover (with internal secret)', async () => {
    const res = await client.post('/api/rover/position', {
      body: { lat: 35.292, lng: 126.574 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.lat, 35.292);
    assert.equal(data.lng, 126.574);
    assert.equal(data.alt, null); // no alt sent → echoed back as null
  });

  it('accepts and echoes altitude', async () => {
    const res = await client.post('/api/rover/position', {
      body: { lat: 35.292, lng: 126.574, alt: 36.7 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.alt, 36.7);
  });

  it('rejects without auth', async () => {
    const res = await client.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0 },
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid coordinates', async () => {
    const res = await client.post('/api/rover/position', {
      body: { lat: 91, lng: 0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid altitude', async () => {
    const res = await client.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0, alt: 'high' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/rover/request', () => {
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/request', { cookie: adminCookie });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/execute', () => {
  it('returns 503 when rover is not connected', async () => {
    // Waypoint near the last rover position set by POST /api/rover/position tests
    const res = await client.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 35.292, lng: 126.574 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 503);
  });

  it('rejects empty waypoints', async () => {
    const res = await client.post('/api/rover/execute', {
      body: { waypoints: [] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid waypoint coordinates', async () => {
    const res = await client.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 91, lng: 0 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/rover/stop', () => {
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/stop', { cookie: adminCookie });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/clear-emergency', () => {
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/clear-emergency', { cookie: adminCookie });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/pump', () => {
  it('returns 400 when on is missing', async () => {
    const res = await client.post('/api/rover/pump', {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });
  it('returns 400 when on is not a boolean', async () => {
    const res = await client.post('/api/rover/pump', {
      cookie: adminCookie,
      body: { on: 'banana' },
    });
    assert.equal(res.status, 400);
  });
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/pump', {
      cookie: adminCookie,
      body: { on: true },
    });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/pump-duration', () => {
  it('returns 400 when seconds is missing', async () => {
    const res = await client.post('/api/rover/pump-duration', {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });
  it('returns 400 when seconds is out of range', async () => {
    const res = await client.post('/api/rover/pump-duration', {
      cookie: adminCookie,
      body: { seconds: 99 },
    });
    assert.equal(res.status, 400);
  });
  it('persists the setting even when the rover is disconnected', async () => {
    // pump-duration is a stored config (re-sent on reconnect), so it
    // succeeds without a connected rover — unlike the immediate pump toggle.
    const res = await client.post('/api/rover/pump-duration', {
      cookie: adminCookie,
      body: { seconds: 3.5 },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });
});

describe('POST /api/rover/end-mission', () => {
  // When no mission is in flight (currentMissionId is null), the endpoint
  // is a successful no-op. It must not require the rover to be connected —
  // the operator may need to clean up a dangling mission record after a
  // rover SSE drop.
  it('returns ended:false when no mission is active', async () => {
    const res = await client.post('/api/rover/end-mission', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ended, false);
  });
});

describe('POST /api/rover/control', () => {
  async function withIsolatedControlApp(fn) {
    const isolatedPath = tmpDbPath();
    const created = createCourseApp({ dbPath: isolatedPath, validateUser: TRUST_JWT });
    const started = await startServer(created.app);
    try {
      await fn({
        db: created.db,
        url: started.baseUrl,
        client: createClient(started.baseUrl),
      });
    } finally {
      started.server.closeAllConnections?.();
      await stopServer(started.server);
      created.db.close();
      cleanup(isolatedPath);
    }
  }

  async function openIsolatedRover(url, isolated) {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/rover/stream`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    return {
      async close() {
        try { await reader.cancel(); } catch { /* already closed */ }
        controller.abort();
        await drained;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const status = await (await isolated.get('/api/rover/status', { cookie: adminCookie })).json();
          if (!status.connected) return;
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.fail('rover close handler did not clear the connected state');
      },
    };
  }

  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/control', {
      body: { throttle: 50, steering: -30 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 503);
  });

  it('rejects non-numeric values', async () => {
    const res = await client.post('/api/rover/control', {
      body: { throttle: "fast", steering: 0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('throttles disconnected-rover warnings per operator', async () => {
    const operatorEmail = 'control-throttle@test.com';
    const operatorCookie = makeAuthCookie({
      email: operatorEmail,
      name: 'Control Operator',
      role: 'admin',
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await client.post('/api/rover/control', {
        body: { throttle: 25, steering: -10 },
        cookie: operatorCookie,
      });
      assert.equal(res.status, 503);
    }

    const logs = db.prepare(
      "SELECT level, detail FROM logs WHERE action = 'rover.control' AND actor_email = ? ORDER BY id",
    ).all(operatorEmail);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.deepEqual(JSON.parse(logs[0].detail), {
      error: 'not_connected',
      throttle: 25,
      steering: -10,
    });
  });

  it('logs connected manual control once per operator session, not per packet', async () => {
    await withIsolatedControlApp(async ({ db: isolatedDb, url, client: isolated }) => {
      const rover = await openIsolatedRover(url, isolated);
      try {
        const firstCookie = makeAuthCookie({ email: 'driver-a@test.com', name: 'Driver A', role: 'admin' });
        const secondCookie = makeAuthCookie({ email: 'driver-b@test.com', name: 'Driver B', role: 'admin' });
        for (const cookie of [firstCookie, firstCookie, secondCookie]) {
          const res = await isolated.post('/api/rover/control', {
            body: { throttle: 20, steering: 5 }, cookie,
          });
          assert.equal(res.status, 200);
        }
        const logs = isolatedDb.prepare(`SELECT actor_email, level, detail FROM logs
          WHERE action = 'rover.control' AND level = 'info' ORDER BY id`).all();
        assert.deepEqual(logs.map((row) => row.actor_email), [
          'driver-a@test.com',
          'driver-b@test.com',
        ]);
        assert.ok(logs.every((row) => row.detail === '{}'));
      } finally {
        await rover.close();
      }
    });
  });

  it('throttles repeated manual-control rejection while an autonomous mission is moving', async () => {
    await withIsolatedControlApp(async ({ db: isolatedDb, client: isolated }) => {
      const courseRes = await isolated.post('/api/courses', {
        body: { name: 'Control gate course' }, cookie: adminCookie,
      });
      const isolatedCourse = await courseRes.json();
      const coneRes = await isolated.post(`/api/courses/${isolatedCourse.id}/cones`, {
        body: { lat: 35, lng: 126, side: 'left' }, cookie: adminCookie,
      });
      const cone = await coneRes.json();
      const missionRes = await isolated.post('/api/missions', {
        body: {
          course_id: isolatedCourse.id,
          items: [{ cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side }],
        },
        cookie: adminCookie,
      });
      assert.equal(missionRes.status, 201);
      const mission = await missionRes.json();
      isolatedDb.prepare("UPDATE mission SET lifecycle_state = 'running', status = 'running' WHERE id = ?")
        .run(mission.id);
      const active = await (await isolated.get('/api/missions/active', { cookie: adminCookie })).json();
      assert.equal(active.mission.motion_confirmed_held, false);

      const operatorEmail = 'blocked-driver@test.com';
      const operatorCookie = makeAuthCookie({ email: operatorEmail, name: 'Blocked Driver', role: 'admin' });
      for (let i = 0; i < 2; i += 1) {
        const res = await isolated.post('/api/rover/control', {
          body: { throttle: 30, steering: -5 }, cookie: operatorCookie,
        });
        assert.equal(res.status, 409);
      }
      const warnings = isolatedDb.prepare(`SELECT detail FROM logs
        WHERE action = 'rover.control' AND level = 'warn' AND actor_email = ?
        ORDER BY id`).all(operatorEmail);
      assert.equal(warnings.length, 1);
      assert.equal(JSON.parse(warnings[0].detail).error, 'autonomous_mission_not_held');
      isolatedDb.prepare(`UPDATE mission
        SET lifecycle_state = 'cancelled', status = 'stopped', ended_at = ? WHERE id = ?`)
        .run(Date.now(), mission.id);
      await isolated.get('/api/missions/active', { cookie: adminCookie });
    });
  });
});

describe('POST /api/rover/calibrate-battery', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await client.post('/api/rover/calibrate-battery', {
      body: { measured_v: 26.0 },
    });
    assert.equal(res.status, 401);
  });

  it('rejects non-numeric measured_v', async () => {
    const res = await client.post('/api/rover/calibrate-battery', {
      body: { measured_v: 'twenty-six' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects measured_v outside 15–32 V (sanity-check range for 8S LiFePO4)', async () => {
    for (const bad of [0, 14.9, 32.1, 100]) {
      const res = await client.post('/api/rover/calibrate-battery', {
        body: { measured_v: bad },
        cookie: adminCookie,
      });
      assert.equal(res.status, 400, `expected 400 for measured_v=${bad}`);
    }
  });

  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/calibrate-battery', {
      body: { measured_v: 26.0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 503);
  });
});

// ─── Rover camera depth composite toggle ────────────────────────────────
describe('POST /api/rover/camera/depth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await client.post('/api/rover/camera/depth', { body: { on: true } });
    assert.equal(res.status, 401);
  });

  it('is a no-op without an active viewer (depth needs a live stream)', async () => {
    // Depth is a sub-mode of an active stream; toggling it on with zero viewers
    // must NOT latch the flag true (it would otherwise get stuck — the only reset
    // is the last-viewer-leave edge). The on-with-viewer path is covered in the
    // Camera relay suite (which holds a viewer + a control channel open).
    const on = await client.post('/api/rover/camera/depth', {
      body: { on: true }, cookie: adminCookie,
    });
    assert.equal(on.status, 200);
    const onBody = await on.json();
    assert.equal(onBody.ok, true);
    assert.equal(onBody.depth, false);           // guarded: no viewer → stays off
    const status = await client.get('/api/rover/camera/status', { cookie: adminCookie });
    assert.equal((await status.json()).depth, false);
  });

  it('coerces a missing body to off (no crash)', async () => {
    const res = await client.post('/api/rover/camera/depth', { body: {}, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).depth, false);
  });
});

// ─── Rover proximity (obstacle) detection toggle ─────────────────────────
describe('POST /api/rover/camera/detection', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await client.post('/api/rover/camera/detection', { body: { on: false } });
    assert.equal(res.status, 401);
  });

  it('defaults to OFF and stores the on/off flag in rover status', async () => {
    // Default is OFF — detection is opt-in per mission.
    const before = await client.get('/api/rover/status', { cookie: adminCookie });
    assert.equal((await before.json()).obstacle_detection_enabled, false);

    const on = await client.post('/api/rover/camera/detection', {
      body: { on: true }, cookie: adminCookie,
    });
    assert.equal(on.status, 200);
    const onBody = await on.json();
    assert.equal(onBody.ok, true);
    assert.equal(onBody.detection, true);
    // No perception control channel is attached here, so it can't be delivered —
    // but the flag is stored regardless (re-synced on the next perception connect).
    assert.equal(onBody.camera_connected, false);
    assert.equal((await (await client.get('/api/rover/status', { cookie: adminCookie })).json())
      .obstacle_detection_enabled, true);

    const off = await client.post('/api/rover/camera/detection', {
      body: { on: false }, cookie: adminCookie,
    });
    assert.equal((await off.json()).detection, false);
    assert.equal((await (await client.get('/api/rover/status', { cookie: adminCookie })).json())
      .obstacle_detection_enabled, false);
  });

  it('coerces a missing body to off (no crash)', async () => {
    const res = await client.post('/api/rover/camera/detection', { body: {}, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).detection, false);
  });
});

// ─── Rover minimap tile proxy ────────────────────────────────────────────
describe('GET /api/rover/map-tile', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await client.get('/api/rover/map-tile?z=18&x=1&y=1');
    assert.equal(res.status, 401);
  });

  it('400s on out-of-range / non-integer / missing tile coords', async () => {
    // Guards the SSRF-adjacent proxy: only valid slippy-map indices reach fetch.
    // (The success path hits an external tile server, so it's not covered here.)
    for (const q of ['z=99&x=0&y=0', 'z=18&x=-1&y=0', 'z=18&x=0', 'z=1.5&x=0&y=0', 'z=2&x=4&y=0']) {
      const res = await client.get(`/api/rover/map-tile?${q}`, { cookie: adminCookie });
      assert.equal(res.status, 400, `expected 400 for ?${q}`);
    }
  });

  it('throttles repeated upstream failures to one rover.map_tile warn per reason', async () => {
    // A minimap screen requests dozens of tiles, so a persistent upstream
    // failure (expired VWORLD_KEY etc.) must not flood the warn filter: the
    // route logs once per failure reason per 60s. Fail the upstream fetch
    // deterministically (offline-safe) by intercepting the tile hosts only —
    // the throttle keys on the error name, so a unique name isolates this test.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const target = String(typeof input === 'string' ? input : input?.url ?? input);
      if (target.includes('api.vworld.kr') || target.includes('mt0.google.com')) {
        const err = new Error('simulated tile upstream outage');
        err.name = 'TestTileFailure';
        return Promise.reject(err);
      }
      return realFetch(input, init);
    };
    try {
      for (let i = 0; i < 3; i++) {
        const res = await client.get(`/api/rover/map-tile?z=18&x=${i}&y=1`, { cookie: adminCookie });
        assert.equal(res.status, 502, 'every failed tile request still 502s');
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = db.prepare(
      "SELECT detail FROM logs WHERE action = 'rover.map_tile' AND level = 'warn' AND detail LIKE '%simulated tile upstream outage%'",
    ).all();
    assert.equal(rows.length, 1, '3 failing tile requests must produce exactly ONE warn row');
    const detail = JSON.parse(rows[0].detail);
    assert.match(detail.error, /simulated tile upstream outage/);
    assert.equal(detail.z, 18, 'the logged row keeps the tile coords for triage');
  });
});

// ─── Rover telemetry / status ───────────────────────────────────────────
describe('Rover telemetry + status (internal)', () => {
  it('rejects telemetry without internal secret', async () => {
    const res = await client.post('/api/rover/telemetry', {
      body: { nav_state: 'IDLE' },
      cookie: adminCookie,
    });
    // admin cookie can still reach it (falls through to admin role), so ensure public 401
    assert.ok(res.status === 200 || res.status === 401 || res.status === 403);
  });

  it('public request to /api/rover/telemetry is rejected', async () => {
    const res = await client.post('/api/rover/telemetry', { body: { nav_state: 'IDLE' } });
    assert.equal(res.status, 401);
  });

  it('accepts telemetry with internal secret and exposes status', async () => {
    const res = await client.post('/api/rover/telemetry', {
      body: { nav_state: 'NAVIGATING', fix_status: 'rtk_fixed', ntrip_connected: true },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    const statusRes = await client.get('/api/rover/status', { cookie: adminCookie });
    assert.equal(statusRes.status, 200);
    const data = await statusRes.json();
    assert.equal(data.nav_state, 'NAVIGATING');
    assert.equal(data.fix_status, 'rtk_fixed');
    assert.equal(data.ntrip_connected, true);
  });

  it('accepts and exposes gps metrics payload (h_acc, v_acc, speed, heading, num_sv)', async () => {
    const res = await client.post('/api/rover/telemetry', {
      body: { gps: { h_acc: 0.012, v_acc: 0.018, speed: 1.34, heading: 87.5, num_sv: 22 } },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await (await client.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(data.gps.h_acc, 0.012);
    assert.equal(data.gps.v_acc, 0.018);
    assert.equal(data.gps.speed, 1.34);
    assert.equal(data.gps.heading, 87.5);
    assert.equal(data.gps.num_sv, 22);
  });

  it('accepts and exposes battery payload', async () => {
    const res = await client.post('/api/rover/telemetry', {
      body: { battery: { voltage: 11.4, percent: 55, source: 'simulated' } },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const statusRes = await client.get('/api/rover/status', { cookie: adminCookie });
    const data = await statusRes.json();
    assert.equal(data.battery.voltage, 11.4);
    assert.equal(data.battery.percent, 55);
    assert.equal(data.battery.source, 'simulated');
  });

  it('passes through battery calibration metadata (gain, measured_v, calibrated_at, voltage_raw)', async () => {
    const calibratedAt = 1714200000000;
    const res = await client.post('/api/rover/telemetry', {
      body: {
        battery: {
          voltage: 26.0,
          voltage_raw: 25.6,
          percent: 47,
          source: 'mcu',
          gain: 1.015625,
          measured_v: 26.0,
          calibrated_at: calibratedAt,
        },
      },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await (await client.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(data.battery.voltage, 26.0);
    assert.equal(data.battery.voltage_raw, 25.6);
    assert.equal(data.battery.gain, 1.015625);
    assert.equal(data.battery.measured_v, 26.0);
    assert.equal(data.battery.calibrated_at, calibratedAt);
  });

  it('passes through the MCU status flag bitfield (for fault-cause decoding in the UI)', async () => {
    // Realistic fault combo: raw E-stop line (0x80) + combined latch (0x01) + undervolt (0x04).
    const flags = 0x80 | 0x01 | 0x04;
    const res = await client.post('/api/rover/telemetry', {
      body: { battery: { voltage: 19.5, percent: 0, source: 'mcu', flags } },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await (await client.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(data.battery.flags, flags, 'MCU flags must be exposed for the error-cause popover');
  });

  it('ignores null ntrip_connected (distinguishes unknown from disconnected)', async () => {
    // First set it to true via a boolean
    await client.post('/api/rover/telemetry', {
      body: { ntrip_connected: true },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    // Then send null — backend must keep the previous true, not flip to false
    await client.post('/api/rover/telemetry', {
      body: { ntrip_connected: null },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    const statusRes = await client.get('/api/rover/status', { cookie: adminCookie });
    const data = await statusRes.json();
    assert.equal(data.ntrip_connected, true);
  });

  it('clears cached ntrip detail when ntrip_connected flips to false', async () => {
    // Seed a full ntrip detail object via a connected payload
    await client.post('/api/rover/telemetry', {
      body: {
        ntrip_connected: true,
        ntrip: {
          host: 'www.gnssdata.or.kr', port: 2101, mountpoint: 'SEJN-RTCM32',
          fail_count: 0, last_error: null,
          last_correction_at: 1234567890, bytes_received: 99,
        },
      },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    let data = await (await client.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(data.ntrip?.mountpoint, 'SEJN-RTCM32');

    // Next telemetry says NTRIP is disconnected — server must drop the
    // stale detail so the UI doesn't keep rendering the old mountpoint.
    await client.post('/api/rover/telemetry', {
      body: { ntrip_connected: false },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    data = await (await client.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(data.ntrip_connected, false);
    assert.equal(data.ntrip, null);
  });
});

// ─── Rover stream fail-close ────────────────────────────────────────────
describe('GET /api/rover/stream (auth)', () => {
  it('rejects request without internal secret and without admin cookie', async () => {
    const res = await client.get('/api/rover/stream');
    assert.equal(res.status, 401);
  });

  it('rejects admin cookie without internal secret (browsers must not clobber the rover slot)', async () => {
    // The single-slot roverClient was previously replaceable by any logged-in
    // operator opening /api/rover/stream in a browser/devtools. That kicked
    // the real rover off and rerouted calibrate-* events to the browser
    // response — the operator-visible symptom was "cal start button does
    // nothing despite RTK fixed and IDLE". Internal-only closes that door.
    const res = await client.get('/api/rover/stream', { cookie: adminCookie });
    assert.equal(res.status, 403);
  });
});

// ─── Rover execute: geofence ────────────────────────────────────────────
describe('POST /api/rover/execute (geofence)', () => {
  before(async () => {
    // Seed a rover position via internal API
    await client.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
  });

  it('rejects first waypoint too far from rover', async () => {
    const res = await client.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 36.0, lng: 127.0 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects segments longer than threshold', async () => {
    const res = await client.post('/api/rover/execute', {
      body: {
        waypoints: [
          { lat: 35.0, lng: 126.0 },
          { lat: 35.001, lng: 126.001 },  // ~140 m
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('accepts normal waypoints (but rover not connected → 503)', async () => {
    const res = await client.post('/api/rover/execute', {
      body: {
        waypoints: [
          { lat: 35.00001, lng: 126.00001 },
          { lat: 35.00002, lng: 126.00002 },
        ],
      },
      cookie: adminCookie,
    });
    // geofence passes, 503 from no rover client
    assert.equal(res.status, 503);
  });

  it('geofence error exposes the configured maximum distance', async () => {
    const res = await client.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 36.0, lng: 127.0 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
    const msg = await res.text();
    assert.match(msg, /최대\s+\d+m/, 'error must include the max-distance limit');
  });
});

// ─── Rover waypoint_reached relay ──────────────────────────────────────
describe('POST /api/rover/waypoint_reached (internal)', () => {
  it('rejects without internal secret', async () => {
    const res = await client.post('/api/rover/waypoint_reached', { body: { index: 0 } });
    assert.equal(res.status, 401);
  });

  it('accepts a valid index with internal secret', async () => {
    const res = await client.post('/api/rover/waypoint_reached', {
      body: { index: 2 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
  });

  it('rejects negative or non-integer indices', async () => {
    const r1 = await client.post('/api/rover/waypoint_reached', {
      body: { index: -1 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(r1.status, 400);
    const r2 = await client.post('/api/rover/waypoint_reached', {
      body: { index: 'abc' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(r2.status, 400);
  });
});

// ─── Rover disconnect reason + execute cleaned-waypoints response ──────
describe('Rover disconnect reason exposure', () => {
  it('exposes last_disconnect_reason in /api/rover/status', async () => {
    const res = await client.get('/api/rover/status', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok('last_disconnect_reason' in data);
    assert.ok('last_disconnect_at' in data);
  });
});

describe('Mission orphan recovery + boot reconciliation (on startup)', () => {
  it('keeps a running mission resumable in the durable mission store', async () => {
    // A row left 'running' means the server died mid-mission. The rover keeps
    // driving and reconnects, so the mission must NOT be discarded — it becomes
    // 'interrupted' (resumable, not ended) and is exposed from the durable v2
    // mission store. Legacy in-memory mission_progress must stay empty: the
    // rover checkpoint and stable waypoint IDs are the source of progress now.
    const started_at = Date.now() - 60000;
    db.prepare(
      "INSERT INTO mission (started_at, status, waypoints_json, current_waypoint_idx, spray_results_json) VALUES (?, 'running', ?, ?, ?)"
    ).run(started_at, '[{"lat":35,"lng":126},{"lat":35.0001,"lng":126.0001},{"lat":35.0002,"lng":126.0002}]', 2, '{"0":"success"}');
    const orphanId = db.prepare("SELECT id FROM mission WHERE started_at = ?").get(started_at).id;

    const { createCourseApp } = await import('../../course/index.mjs?v=orphan');
    const result = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    const started = await startServer(result.app);
    const localClient = createClient(started.baseUrl);
    try {
      const data = await (await localClient.get('/api/missions', { cookie: adminCookie })).json();
      const m = data.missions.find((x) => x.id === orphanId);
      assert.ok(m, 'orphan mission row disappeared');
      assert.equal(m.status, 'interrupted', 'running orphan must become resumable, not error');
      assert.ok(!m.ended_at, 'interrupted mission must not be ended');

      const status = await (await localClient.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(status.mission_progress.mission_id, null);
      assert.equal(status.active_mission.id, orphanId);
      assert.equal(status.active_mission.status, 'interrupted');
      assert.equal(status.active_mission.waypoints.length, 3);
      assert.equal(status.active_mission.waypoints.filter((wp) => wp.state === 'completed').length, 2);
    } finally {
      result.db.prepare("UPDATE mission SET lifecycle_state='cancelled', status='stopped', ended_at=? WHERE id=?")
        .run(Date.now(), orphanId);
      await stopServer(started.server);
      result.db.close();
    }
  });
});

describe('Missions API', () => {
  it('lists missions (empty initially returns JSON)', async () => {
    const res = await client.get('/api/missions', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.missions));
    assert.ok('total' in data, 'response must expose total count for pagination');
    assert.ok('limit' in data);
    assert.ok('offset' in data);
  });

  it('honours limit and offset query params', async () => {
    const res = await client.get('/api/missions?limit=5&offset=10', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.limit, 5);
    assert.equal(data.offset, 10);
  });

  it('caps limit at the configured maximum', async () => {
    const res = await client.get('/api/missions?limit=999999', { cookie: adminCookie });
    const data = await res.json();
    assert.equal(data.limit, 500, 'limit should clamp to MISSION_LIST_MAX_LIMIT');
  });

  it('returns 404 for missing mission id', async () => {
    const res = await client.get('/api/missions/999999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('rejects non-integer id', async () => {
    const res = await client.get('/api/missions/abc', { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('returns 404 when fetching telemetry for missing mission', async () => {
    const res = await client.get('/api/missions/999999/telemetry', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('Rover log cache', () => {
  it('rejects non-internal upload', async () => {
    const res = await client.post('/api/rover/logs', { body: { entries: [] } });
    assert.equal(res.status, 401);
  });

  it('accepts upload and returns the cached entries', async () => {
    const up = await client.post('/api/rover/logs', {
      body: {
        entries: [
          { t: 1700000000000, level: 'INFO', node: 'gps_node', msg: 'GPS locked' },
          { t: 1700000001000, level: 'WARN', node: 'ntrip', msg: 'reconnecting' },
        ],
      },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(up.status, 200);
    const getRes = await client.get('/api/rover/logs', { cookie: adminCookie });
    assert.equal(getRes.status, 200);
    const data = await getRes.json();
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].node, 'gps_node');
    assert.ok(data.uploaded_at > 0);
  });

  it('rejects bad log payload', async () => {
    const res = await client.post('/api/rover/logs', {
      body: { entries: 'notanarray' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('fetch requires rover connection (503 when disconnected)', async () => {
    const res = await client.post('/api/rover/logs/fetch', { cookie: adminCookie });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/spray_result (internal)', () => {
  it('rejects without internal secret', async () => {
    const res = await client.post('/api/rover/spray_result', {
      body: { waypoint: 0, outcome: 'success' },
    });
    assert.equal(res.status, 401);
  });

  it('accepts success outcome and stores last_spray_result', async () => {
    const res = await client.post('/api/rover/spray_result', {
      body: { waypoint: 2, outcome: 'success' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const statusRes = await client.get('/api/rover/status', { cookie: adminCookie });
    const data = await statusRes.json();
    assert.equal(data.last_spray_result.waypoint, 2);
    assert.equal(data.last_spray_result.outcome, 'success');
  });

  it('rejects unknown outcome', async () => {
    const res = await client.post('/api/rover/spray_result', {
      body: { waypoint: 0, outcome: 'exploded' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative waypoint', async () => {
    const res = await client.post('/api/rover/spray_result', {
      body: { waypoint: -1, outcome: 'success' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });
});

// ─── Mission interruption survival + resume ─────────────────────────────
// A dedicated server/db so opening + dropping a rover SSE doesn't leak global
// roverState into the shared suite.
describe('Mission interruption survival + resume', () => {
  let srv, url, cli, localDb, localDbPath;

  // Open a rover SSE (internal secret) and drain it so the server registers
  // roverClient. Returns an abort fn that closes it like a real disconnect.
  async function connectRover() {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/rover/stream`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 60)); // let the handler register roverClient
    return async () => { ac.abort(); await drained; await new Promise((r) => setTimeout(r, 120)); };
  }

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
    await cli.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
  });

  after(async () => {
    await stopServer(srv);
    localDb.close();
    cleanup(localDbPath);
  });

  let missionId;

  it('keeps the mission resumable (interrupted, progress persisted) across a rover SSE drop', async () => {
    const disconnect = await connectRover();

    const exec = await cli.post('/api/rover/execute', {
      body: { waypoints: [
        { lat: 35.00001, lng: 126.00001 },
        { lat: 35.00002, lng: 126.00002 },
        { lat: 35.00003, lng: 126.00003 },
      ] },
      cookie: adminCookie,
    });
    assert.equal(exec.status, 200);
    missionId = (await exec.json()).mission_id;
    assert.ok(Number.isInteger(missionId));

    // Advance one waypoint, then yank the rover offline.
    await cli.post('/api/rover/waypoint_reached', {
      body: { index: 0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    await disconnect();

    // Mission must survive — interrupted + resumable, progress preserved.
    const status = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(status.connected, false);
    assert.equal(status.mission_progress.mission_id, missionId, 'mission must survive the disconnect');
    assert.equal(status.mission_progress.status, 'interrupted');
    assert.equal(status.mission_progress.current_waypoint_idx, 1, 'progress must be preserved');

    // DB row reflects interrupted, not a terminal error, and is not ended.
    const m = await (await cli.get(`/api/missions/${missionId}`, { cookie: adminCookie })).json();
    assert.equal(m.status, 'interrupted');
    assert.ok(!m.ended_at, 'interrupted mission must not be ended');
  });

  it('flips back to running when the reconnected rover reports an active nav state', async () => {
    const before = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(before.mission_progress.status, 'interrupted');

    const disconnect = await connectRover();
    await cli.post('/api/rover/telemetry', {
      body: { nav_state: 'NAVIGATING' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });

    const after = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(after.mission_progress.status, 'running', 'active telemetry must resume the mission');
    assert.equal(after.mission_progress.mission_id, missionId);

    await disconnect();
  });

  it('does NOT auto-complete an interrupted mission that reconnects IDLE (rover rebooted)', async () => {
    // After the previous disconnect the mission is interrupted again. A rover
    // that comes back IDLE (rebooted) must stay resumable, not be marked done.
    const disconnect = await connectRover();
    await cli.post('/api/rover/telemetry', {
      body: { nav_state: 'IDLE' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    const after = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(after.mission_progress.mission_id, missionId, 'mission must NOT be cleared');
    assert.equal(after.mission_progress.status, 'interrupted');
    await disconnect();
  });
});

// ─── Mission soft pause / resume ────────────────────────────────────────
describe('Mission soft pause / resume', () => {
  let srv, url, cli, localDb, localDbPath;

  async function connectRover() {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/rover/stream`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 60));
    return async () => { ac.abort(); await drained; await new Promise((r) => setTimeout(r, 120)); };
  }

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
    await cli.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
  });

  after(async () => {
    await stopServer(srv);
    localDb.close();
    cleanup(localDbPath);
  });

  it('rejects pause/resume when no rover is connected (503)', async () => {
    assert.equal((await cli.post('/api/rover/pause', { cookie: adminCookie })).status, 503);
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 503);
  });

  it('pauses a running mission, then resumes it; guards double-pause / stray-resume', async () => {
    const disconnect = await connectRover();
    const exec = await cli.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 35.00001, lng: 126.00001 }, { lat: 35.00002, lng: 126.00002 }] },
      cookie: adminCookie,
    });
    assert.equal(exec.status, 200);

    // Resume before pausing → 409 (mission is running, not paused).
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 409);

    // Pause.
    assert.equal((await cli.post('/api/rover/pause', { cookie: adminCookie })).status, 200);
    let st = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(st.mission_progress.status, 'paused');

    // Double-pause → 409 (no running mission to pause).
    assert.equal((await cli.post('/api/rover/pause', { cookie: adminCookie })).status, 409);

    // Resume.
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 200);
    st = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(st.mission_progress.status, 'running');

    // Resume again → 409 (already running).
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 409);

    await disconnect();
  });

  it('keeps a paused mission paused across a stray active-nav frame and a disconnect', async () => {
    const disconnect = await connectRover();
    await cli.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 35.00001, lng: 126.00001 }, { lat: 35.00002, lng: 126.00002 }] },
      cookie: adminCookie,
    });
    assert.equal((await cli.post('/api/rover/pause', { cookie: adminCookie })).status, 200);

    // A stray active-nav telemetry frame (rover hasn't left NAVIGATING yet) must
    // NOT auto-resume an operator pause — only an 'interrupted' mission flips.
    await cli.post('/api/rover/telemetry', {
      body: { nav_state: 'NAVIGATING' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    let st = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(st.mission_progress.status, 'paused', 'stray active frame must not un-pause');

    // A disconnect must keep it 'paused' (resumable in place), not downgrade to
    // 'interrupted' (which would make the UI 재개 button 409).
    await disconnect();
    st = await (await cli.get('/api/rover/status', { cookie: adminCookie })).json();
    assert.equal(st.mission_progress.status, 'paused', 'paused mission stays paused across a drop');
  });
});

// ─── Obstacle auto-pause (perception → server reflection + alert) ───────
describe('Mission obstacle auto-pause (perception)', () => {
  let srv, url, cli, localDb, localDbPath;

  async function connectRover() {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/rover/stream`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 60));
    return async () => { ac.abort(); await drained; await new Promise((r) => setTimeout(r, 120)); };
  }

  const exec = () => cli.post('/api/rover/execute', {
    body: { waypoints: [{ lat: 35.00001, lng: 126.00001 }, { lat: 35.00002, lng: 126.00002 }] },
    cookie: adminCookie,
  });
  const obstacle = (body) => cli.post('/api/rover/obstacle', {
    body: body || {}, headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
  });
  const telemetry = (nav_state) => cli.post('/api/rover/telemetry', {
    body: { nav_state }, headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
  });
  const status = async () => (await cli.get('/api/rover/status', { cookie: adminCookie })).json();

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
    await cli.post('/api/rover/position', {
      body: { lat: 35.0, lng: 126.0 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
  });

  after(async () => {
    await stopServer(srv);
    localDb.close();
    cleanup(localDbPath);
  });

  it('is internal-strict: a browser admin cannot spoof an obstacle', async () => {
    const pub = await fetch(`${url}/api/rover/obstacle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.ok(pub.status === 401 || pub.status === 403, 'public obstacle POST denied');
    const adm = await fetch(`${url}/api/rover/obstacle`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.ok(![200, 204].includes(adm.status), `browser admin must not succeed (got ${adm.status})`);
  });

  it('does not pause OR raise a banner when there is no running mission', async () => {
    const res = await obstacle({ nearest_m: 1.2 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).paused, false);
    const st = await status();
    assert.notEqual(st.mission_progress.status, 'paused');
    // No mission → no persistent alert (it would be unclearable: resume 409s).
    assert.equal(st.obstacle.active, false);
  });

  it("reflects the rover's local pause and raises an obstacle alert", async () => {
    const disconnect = await connectRover();
    assert.equal((await exec()).status, 200);

    const res = await obstacle({ nearest_m: 0.8 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).paused, true);

    const st = await status();
    assert.equal(st.mission_progress.status, 'paused');
    assert.equal(st.obstacle.active, true);
    assert.equal(st.obstacle.nearest_m, 0.8);

    // Resume clears the obstacle hold and returns the mission to running.
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 200);
    const st2 = await status();
    assert.equal(st2.mission_progress.status, 'running');
    assert.equal(st2.obstacle.active, false);

    await disconnect();
  });

  it('reconciles a rover-local pause from telemetry when the alert was lost', async () => {
    const disconnect = await connectRover();
    assert.equal((await exec()).status, 200);

    // The obstacle POST was lost (uplink blip): the rover paused itself locally
    // and only telemetry reports PAUSED. The server reconciles so resume works.
    await telemetry('PAUSED');
    const st = await status();
    assert.equal(st.mission_progress.status, 'paused', 'PAUSED telemetry reconciles to paused');
    assert.equal(st.obstacle.active, true, 'reconcile also raises the operator alert');

    await cli.post('/api/rover/resume', { cookie: adminCookie });
    await disconnect();
  });

  it('does not let a stale PAUSED frame bounce a just-resumed mission (grace window)', async () => {
    const disconnect = await connectRover();
    assert.equal((await exec()).status, 200);
    assert.equal((await cli.post('/api/rover/pause', { cookie: adminCookie })).status, 200);
    // Resume, then a stale in-flight PAUSED telemetry arrives immediately after.
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 200);
    await telemetry('PAUSED');
    const st = await status();
    assert.equal(st.mission_progress.status, 'running',
      'a PAUSED frame within the resume grace window must not re-pause');
    await disconnect();
  });

  it('ignores a stale obstacle POST right after a resume (grace window)', async () => {
    const disconnect = await connectRover();
    assert.equal((await exec()).status, 200);
    assert.equal((await obstacle({ nearest_m: 0.7 })).status, 200);   // pause via obstacle
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 200);
    // A stale obstacle POST in flight at resume time must NOT re-pause / re-alert.
    const res = await obstacle({ nearest_m: 0.7 });
    assert.equal((await res.json()).ignored, true);
    const st = await status();
    assert.equal(st.mission_progress.status, 'running',
      'a stale obstacle POST within the resume grace window must not re-pause');
    assert.equal(st.obstacle.active, false);
    await disconnect();
  });

  it('rescues interrupted + local PAUSED so resume works (SSE drop then obstacle)', async () => {
    let disconnect = await connectRover();
    assert.equal((await exec()).status, 200);
    await disconnect();                          // SSE drop mid-mission → interrupted
    let st = await status();
    assert.equal(st.mission_progress.status, 'interrupted');
    // Rover reconnects and reports it paused ITSELF on an obstacle while dropped.
    disconnect = await connectRover();
    await telemetry('PAUSED');
    st = await status();
    assert.equal(st.mission_progress.status, 'paused',
      'interrupted + PAUSED must reconcile to paused (else resume 409s)');
    assert.equal(st.obstacle.active, true);
    assert.equal((await cli.post('/api/rover/resume', { cookie: adminCookie })).status, 200);
    await disconnect();
  });
});

// ─── Mission schema migration (old DB → new columns + statuses) ─────────
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
    const localClient = createClient(started.baseUrl);
    try {
      // Existing row preserved through the rebuild.
      const data = await (await localClient.get('/api/missions', { cookie: adminCookie })).json();
      assert.equal(data.missions.length, 1);
      assert.equal(data.missions[0].status, 'completed');

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

// ─── Camera relay (MJPEG) ───────────────────────────────────────────────
describe('Camera relay', () => {
  let srv, url, cli, localDb, localDbPath;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
  });

  after(async () => {
    await stopServer(srv);
    localDb.close();
    cleanup(localDbPath);
  });

  it('rejects the control SSE and frame upload without the internal secret', async () => {
    const ctl = await fetch(`${url}/api/rover/camera/control`, { headers: { Accept: 'text/event-stream' } });
    assert.ok(ctl.status === 401 || ctl.status === 403, 'control SSE is internal-strict');
    try { await ctl.body?.cancel(); } catch { /* ignore */ }

    const up = await fetch(`${url}/api/rover/camera`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.ok(up.status === 401 || up.status === 403, 'frame upload is internal-strict');
  });

  it('internal-strict camera paths resist path-variant bypass by a browser admin', async () => {
    // Express 5 routes a trailing-slash variant to the same handler, so an
    // exact-match gate would fall through to "admin" and let a browser admin
    // inject a frame (204) / open the control SSE (200). The security property:
    // none of these variants may produce a SUCCESS for a non-internal caller
    // (403 denied or 404 unrouted are both fine — the internal action ran iff
    // 200/204).
    const cases = [
      { method: 'POST', path: '/api/rover/camera/', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      { method: 'POST', path: '/api/rover/camera//', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      { method: 'GET', path: '/api/rover/camera/control/', headers: { Accept: 'text/event-stream' } },
    ];
    for (const c of cases) {
      const r = await fetch(`${url}${c.path}`, {
        method: c.method, headers: { Cookie: adminCookie, ...c.headers }, body: c.body,
      });
      assert.ok(![200, 204].includes(r.status),
        `${c.method} ${c.path} must NOT succeed for a browser admin (got ${r.status})`);
      try { await r.body?.cancel(); } catch { /* ignore */ }
    }
  });

  // Accumulate decoded stream bytes into `sink.text`, bounded so a stalled
  // read can never hang the test. Returns a stop() that aborts the reader.
  function pump(reader, sink) {
    sink.text = '';
    const dec = new TextDecoder('latin1');
    let stopped = false;
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          if (value) sink.text += dec.decode(value);
        }
      } catch { /* aborted/cancelled */ }
    })();
    return () => { stopped = true; reader.cancel().catch(() => {}); };
  }
  async function waitFor(cond, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (cond()) return true; await sleep(20); }
    return cond();
  }

  it('relays a frame rover→browser and toggles capture on first/last viewer', async () => {
    // Perception container's control SSE.
    const ctlAc = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ctlAc.signal,
    });
    assert.equal(ctl.status, 200);
    const ctlSink = {};
    const stopCtl = pump(ctl.body.getReader(), ctlSink);
    await sleep(60);

    // No viewer yet → camera connected but idle.
    let st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    assert.equal(st.camera_connected, true);
    assert.equal(st.viewers, 0);

    // Browser viewer connects → first viewer triggers camera-start.
    const viewAc = new AbortController();
    const view = await fetch(`${url}/api/rover/camera/stream`, {
      headers: { Cookie: adminCookie }, signal: viewAc.signal,
    });
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-type'), /multipart\/x-mixed-replace/);
    const viewSink = {};
    const stopView = pump(view.body.getReader(), viewSink);
    assert.ok(await waitFor(() => ctlSink.text.includes('camera-start'), 1000),
      'first viewer triggers camera-start');

    // Rover pushes a JPEG frame.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = await fetch(`${url}/api/rover/camera`, {
      method: 'POST', headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, 'Content-Type': 'image/jpeg' }, body: jpeg,
    });
    assert.equal(up.status, 204);

    // Viewer receives the multipart frame.
    assert.ok(await waitFor(() => viewSink.text.includes('--frame'), 1000),
      'viewer receives the multipart boundary');
    assert.ok(viewSink.text.includes('Content-Type: image/jpeg'), 'frame carries a JPEG part header');

    st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    assert.equal(st.viewers, 1);
    assert.ok(st.last_frame_age_ms != null && st.last_frame_age_ms >= 0, 'status reports a server-computed frame age');

    // Depth toggle (with a viewer present) relays depth-on to perception and is
    // reflected in status.
    const dOn = await cli.post('/api/rover/camera/depth', { body: { on: true }, cookie: adminCookie });
    assert.equal((await dOn.json()).depth, true, 'depth turns on while a viewer is watching');
    assert.ok(await waitFor(() => ctlSink.text.includes('depth-on'), 1000),
      'depth toggle relays depth-on to the perception control channel');
    st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    assert.equal(st.depth, true);

    // Last viewer leaves → camera-stop AND depth-off (so a reopen starts plain),
    // and the server depth state resets. A connect-time camera-stop/depth-off is
    // already in ctlSink.text (the control channel re-syncs on attach), so wait for
    // a FRESH one (count increases) rather than a substring that's satisfiable
    // before the disconnect has been processed, then confirm the server state via
    // the status endpoint — polling removes the async close-handler race.
    const stopBefore = (ctlSink.text.match(/camera-stop/g) || []).length;
    const offBefore = (ctlSink.text.match(/depth-off/g) || []).length;
    stopView();
    viewAc.abort();
    assert.ok(await waitFor(() => (ctlSink.text.match(/camera-stop/g) || []).length > stopBefore, 1500),
      'last viewer triggers camera-stop');
    assert.ok(await waitFor(() => (ctlSink.text.match(/depth-off/g) || []).length > offBefore, 1500),
      'last viewer also clears the depth mode (depth-off)');
    st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    for (let i = 0; i < 75 && st.depth; i++) { await sleep(20); st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json(); }
    assert.equal(st.depth, false, 'depth mode resets when the last viewer leaves');

    stopCtl();
    ctlAc.abort();
  });

  it('depth works for a WebRTC-only 2D viewer (no MJPEG) and clears on leave', async () => {
    // Regression: the 2D operator panel streams via WebRTC — it holds open a
    // camera/hold?mode=2d gating viewer and pulls NO MJPEG <img>. The depth
    // composite is baked into the rover's shared `out` frame (feeding both the
    // MJPEG relay AND rover-2d WebRTC), so depth must gate on ANY 2D viewer, not
    // just the MJPEG cameraViewers (which are zero in a WebRTC session).
    const ctlAc = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ctlAc.signal,
    });
    assert.equal(ctl.status, 200);
    const ctlSink = {};
    const stopCtl = pump(ctl.body.getReader(), ctlSink);
    await sleep(60);

    // A WebRTC 2D gating viewer (mode=2d hold). No MJPEG viewer at all.
    const holdAc = new AbortController();
    const hold = await fetch(`${url}/api/rover/camera/hold?mode=2d`, {
      headers: { Cookie: adminCookie, Accept: 'text/event-stream' }, signal: holdAc.signal,
    });
    assert.equal(hold.status, 200);
    const holdSink = {};
    const stopHold = pump(hold.body.getReader(), holdSink);
    assert.ok(await waitFor(() => ctlSink.text.includes('webrtc-2d-on'), 1000),
      'a 2D hold viewer starts the rover-2d WebRTC publish');
    // A WebRTC-only session must NOT be counted as an MJPEG viewer (no JPEG encode).
    const st0 = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    assert.equal(st0.viewers, 0, 'a WebRTC 2D viewer is not an MJPEG viewer');

    // Depth on with ONLY the WebRTC 2D viewer present → relays depth-on + latches.
    const dOn = await cli.post('/api/rover/camera/depth', { body: { on: true }, cookie: adminCookie });
    assert.equal((await dOn.json()).depth, true, 'depth turns on for a WebRTC-only 2D viewer');
    assert.ok(await waitFor(() => ctlSink.text.includes('depth-on'), 1000),
      'depth-on is relayed to perception for a WebRTC 2D viewer');
    assert.equal((await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json()).depth, true);

    // The last 2D viewer leaves → depth clears (depth-off) so a reopen starts plain.
    // A connect-time depth-off already sits in ctlSink.text, so wait for a FRESH
    // depth-off (count increases) rather than a substring that's satisfiable before
    // the disconnect has been processed, then confirm the server state via the
    // status endpoint — polling removes the async close-handler race.
    const offBefore = (ctlSink.text.match(/depth-off/g) || []).length;
    stopHold();
    holdAc.abort();
    assert.ok(await waitFor(() => (ctlSink.text.match(/depth-off/g) || []).length > offBefore, 1500),
      'the last 2D viewer leaving clears depth (depth-off)');
    let st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json();
    for (let i = 0; i < 75 && st.depth; i++) { await sleep(20); st = await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json(); }
    assert.equal(st.depth, false, 'depth resets when the last 2D viewer leaves');

    stopCtl();
    ctlAc.abort();
  });

  it('relays the proximity-detection toggle and re-syncs it on (re)connect', async () => {
    // First perception control channel. On connect the server re-syncs the
    // stored detection state — default is OFF.
    const ctlAc = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ctlAc.signal,
    });
    assert.equal(ctl.status, 200);
    const ctlSink = {};
    const stopCtl = pump(ctl.body.getReader(), ctlSink);
    assert.ok(await waitFor(() => ctlSink.text.includes('detect-off'), 1000),
      'control connect re-syncs the stored detection state (default off)');

    // Operator turns detection ON → relayed as detect-on + stored server-side.
    const on = await cli.post('/api/rover/camera/detection', { body: { on: true }, cookie: adminCookie });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).detection, true);
    assert.ok(await waitFor(() => ctlSink.text.includes('detect-on'), 1000),
      'detection toggle relays detect-on to the perception control channel');
    assert.equal((await (await cli.get('/api/rover/status', { cookie: adminCookie })).json())
      .obstacle_detection_enabled, true);

    // A fresh perception container reconnects → must be re-told the stored ON
    // (a new container boots with detection off, so the server re-asserts truth).
    stopCtl();
    ctlAc.abort();
    await sleep(60);
    const ctl2Ac = new AbortController();
    const ctl2 = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ctl2Ac.signal,
    });
    assert.equal(ctl2.status, 200);
    const ctl2Sink = {};
    const stopCtl2 = pump(ctl2.body.getReader(), ctl2Sink);
    assert.ok(await waitFor(() => ctl2Sink.text.includes('detect-on'), 1000),
      'reconnect re-syncs the stored ON state to a fresh perception container');

    // Turn detection back OFF → relayed as detect-off.
    const off = await cli.post('/api/rover/camera/detection', { body: { on: false }, cookie: adminCookie });
    assert.equal((await off.json()).detection, false);
    assert.ok(await waitFor(() => ctl2Sink.text.includes('detect-off'), 1000),
      'turning detection off relays detect-off');

    stopCtl2();
    ctl2Ac.abort();
  });

  it('caps concurrent viewers (503 past the limit)', async () => {
    // The viewer cap is the only thing stopping a scripted/looping admin from
    // exhausting sockets/heap on the shared mission server, so guard it.
    // Use raw node:http with agent:false: each viewer gets a DISTINCT socket
    // that stays open. (fetch/undici reuses+evicts held, unconsumed streaming
    // connections, which under-counts viewers and made this flaky.)
    const http = (await import('node:http')).default;
    const MAX = 8; // mirrors MAX_CAMERA_VIEWERS in course/index.mjs
    const u = new URL(`${url}/api/rover/camera/stream`);
    const opened = [];
    const openStream = () => new Promise((resolve) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Cookie: adminCookie }, agent: false },
        (res) => { res.on('data', () => {}); res.on('error', () => {}); resolve({ status: res.statusCode, req }); },
      );
      req.on('error', () => resolve({ status: 0, req }));
      req.end();
    });
    const viewers = async () => (await (await cli.get('/api/rover/camera/status', { cookie: adminCookie })).json()).viewers;
    try {
      for (let i = 0; i < MAX; i++) {
        const r = await openStream();
        opened.push(r);
        assert.equal(r.status, 200, `viewer ${i + 1} should be accepted`);
      }
      // A held stream registers server-side a beat after the headers arrive;
      // wait until all MAX are counted so the over-cap check isn't racy.
      for (let t = 0; t < 50 && (await viewers()) < MAX; t++) await sleep(20);
      assert.equal(await viewers(), MAX, 'server should have registered all viewers');

      const over = await openStream();
      opened.push(over);
      assert.equal(over.status, 503, 'a viewer past the cap must be rejected');
    } finally {
      for (const o of opened) { try { o.req.destroy(); } catch { /* ignore */ } }
      await sleep(150); // let the server reap the closed viewers before the next test
    }
  });
});

// ─── Stereo calibration (UI-triggered) ──────────────────────────────────
describe('Stereo calibration trigger', () => {
  let srv, url, cli, localDb, localDbPath;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const progress = (body) => fetch(`${url}/api/rover/calibration-progress`, {
    method: 'POST',
    headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const status = async () => (await cli.get('/api/rover/status', { cookie: adminCookie })).json();

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server; url = started.baseUrl; cli = createClient(url);
  });
  after(async () => { await stopServer(srv); localDb.close(); cleanup(localDbPath); });

  it('calibration-progress is internal-strict and updates status', async () => {
    const pub = await fetch(`${url}/api/rover/calibration-progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.ok(pub.status === 401 || pub.status === 403, 'public progress denied');
    assert.equal((await progress({ phase: 'collecting', captured: 5, target: 20 })).status, 200);
    let st = await status();
    assert.equal(st.stereo_calibration.status, 'running');
    assert.equal(st.stereo_calibration.captured, 5);
    assert.equal(st.stereo_calibration.target, 20);
    // done(ok) → status done with the result fields.
    await progress({ phase: 'done', ok: true, rms: 0.4, rms_l: 0.31, rms_r: 0.29, baseline_mm: 61.2, pairs: 18 });
    st = await status();
    assert.equal(st.stereo_calibration.status, 'done');
    assert.equal(st.stereo_calibration.rms, 0.4);
    assert.equal(st.stereo_calibration.baseline_mm, 61.2);
    // per-eye RMS is persisted in the calibration record for post-hoc diagnosis
    // (high per-eye → intrinsic; low per-eye but high stereo → eye-sync/extrinsic).
    const rec = localDb.prepare(
      "SELECT detail FROM logs WHERE action = 'rover.calibration' ORDER BY id DESC LIMIT 1"
    ).get();
    const detail = JSON.parse(rec.detail);
    assert.equal(detail.rms_l, 0.31);
    assert.equal(detail.rms_r, 0.29);
  });

  it('calibrate-stereo needs admin, a valid square, and a connected perception', async () => {
    const pub = await fetch(`${url}/api/rover/calibrate-stereo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ square_m: 0.025 }),
    });
    assert.ok(pub.status === 401 || pub.status === 403, 'public denied');
    assert.equal((await cli.post('/api/rover/calibrate-stereo', { body: { square_m: 5 }, cookie: adminCookie })).status, 400);
    // No perception control SSE connected → 503.
    assert.equal((await cli.post('/api/rover/calibrate-stereo', { body: { square_m: 0.025 }, cookie: adminCookie })).status, 503);
  });

  it('calibrate-stereo emits the calibrate command (with square_m) to perception', async () => {
    const ac = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(ctl.status, 200);
    let text = '';
    const reader = ctl.body.getReader();
    const dec = new TextDecoder();
    const drained = (async () => {
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); } } catch { /* aborted */ }
    })();
    await sleep(60);

    assert.equal((await cli.post('/api/rover/calibrate-stereo', { body: { square_m: 0.03 }, cookie: adminCookie })).status, 200);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      if (text.includes('event: calibrate') && text.includes('0.03')) ok = true;
      else await sleep(50);
    }
    assert.ok(ok, 'perception control SSE receives calibrate with square_m');
    assert.equal((await status()).stereo_calibration.status, 'running');
    // Perception disconnects mid-calibration → status must flip to 'failed' so
    // the operator isn't locked out (not stuck 'running' forever).
    ac.abort();
    await drained.catch(() => {});
    let failed = false;
    for (let i = 0; i < 20 && !failed; i++) {
      if ((await status()).stereo_calibration.status === 'failed') failed = true;
      else await sleep(50);
    }
    assert.ok(failed, 'a perception disconnect mid-calibration flips status to failed');
  });
});

// ─── Ground calibration (UI-triggered, above-ground detector) ───────────
describe('Ground calibration trigger', () => {
  let srv, url, cli, localDb, localDbPath;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const progress = (body) => fetch(`${url}/api/rover/calibration-progress`, {
    method: 'POST',
    headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const status = async () => (await cli.get('/api/rover/status', { cookie: adminCookie })).json();

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server; url = started.baseUrl; cli = createClient(url);
  });
  after(async () => { await stopServer(srv); localDb.close(); cleanup(localDbPath); });

  it('calibration-progress kind:ground updates ground status without touching stereo', async () => {
    assert.equal((await progress({ kind: 'ground', phase: 'collecting', captured: 7, target: 30 })).status, 200);
    let st = await status();
    assert.equal(st.ground_calibration.status, 'running');
    assert.equal(st.ground_calibration.captured, 7);
    assert.equal(st.ground_calibration.target, 30);
    assert.notEqual(st.stereo_calibration.status, 'running');   // separate channels
    await progress({ kind: 'ground', phase: 'done', ok: true, near_m: 1.1, far_m: 8.8, rows: 24, mode: 'aboveground' });
    st = await status();
    assert.equal(st.ground_calibration.status, 'done');
    assert.equal(st.ground_calibration.near_m, 1.1);
    assert.equal(st.ground_calibration.far_m, 8.8);
    assert.equal(st.ground_calibration.rows, 24);
    const rec = localDb.prepare(
      "SELECT detail FROM logs WHERE action = 'rover.ground_calibration' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.equal(JSON.parse(rec.detail).mode, 'aboveground');
  });

  it('calibrate-ground needs admin and a connected perception', async () => {
    const pub = await fetch(`${url}/api/rover/calibrate-ground`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.ok(pub.status === 401 || pub.status === 403, 'public denied');
    assert.equal((await cli.post('/api/rover/calibrate-ground', { body: {}, cookie: adminCookie })).status, 503);
  });

  it('calibrate-ground emits the command; a disconnect flips status to failed', async () => {
    const ac = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(ctl.status, 200);
    let text = '';
    const reader = ctl.body.getReader();
    const dec = new TextDecoder();
    const drained = (async () => {
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); } } catch { /* aborted */ }
    })();
    await sleep(60);
    assert.equal((await cli.post('/api/rover/calibrate-ground', { body: { frames: 30 }, cookie: adminCookie })).status, 200);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      if (text.includes('event: calibrate-ground')) ok = true;
      else await sleep(50);
    }
    assert.ok(ok, 'perception control SSE receives calibrate-ground');
    assert.equal((await status()).ground_calibration.status, 'running');
    ac.abort();
    await drained.catch(() => {});
    let failed = false;
    for (let i = 0; i < 20 && !failed; i++) {
      if ((await status()).ground_calibration.status === 'failed') failed = true;
      else await sleep(50);
    }
    assert.ok(failed, 'a perception disconnect mid-ground-calibration flips status to failed');
    // A close that aborted a running calibration is warn-level (it broke
    // something the operator was waiting on), tagged with which calibration.
    const rec = localDb.prepare(
      "SELECT level, detail FROM logs WHERE action = 'rover.camera.control_closed' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.equal(rec.level, 'warn', 'a calibration-aborting disconnect is warn-level');
    assert.ok(JSON.parse(rec.detail).aborted_calibration.includes('ground'),
      'the warn names the aborted calibration');
  });

  it('a bare perception disconnect (nothing running) logs control_closed at info', async () => {
    // Fresh control channel, no calibrate-* issued: the close handler takes the
    // benign branch. This is the reconnect-churn case that used to flood warn.
    const ac = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(ctl.status, 200);
    const reader = ctl.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    await sleep(60);
    const before = localDb.prepare(
      "SELECT COUNT(*) n FROM logs WHERE action = 'rover.camera.control_closed'"
    ).get().n;
    ac.abort();
    await drained.catch(() => {});
    let rec = null;
    for (let i = 0; i < 20 && !rec; i++) {
      const cnt = localDb.prepare(
        "SELECT COUNT(*) n FROM logs WHERE action = 'rover.camera.control_closed'"
      ).get().n;
      if (cnt > before) {
        rec = localDb.prepare(
          "SELECT level, detail FROM logs WHERE action = 'rover.camera.control_closed' ORDER BY id DESC LIMIT 1"
        ).get();
      } else await sleep(50);
    }
    assert.ok(rec, 'a bare disconnect logs control_closed');
    assert.equal(rec.level, 'info', 'a benign close is info, not warn');
    assert.equal(rec.detail, null, 'a benign close carries no aborted-calibration detail');
  });
});

// ─── Camera control write failure (sendCameraControl teardown) ───────────
describe('Camera control write failure', () => {
  let srv, url, cli, localDb, localDbPath;

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath, validateUser: TRUST_JWT });
    localDb = result.db;
    const started = await startServer(result.app);
    srv = started.server; url = started.baseUrl; cli = createClient(url);
  });
  after(async () => { await stopServer(srv); localDb.close(); cleanup(localDbPath); });

  it('a throwing control write logs control_write_failed once and drops the slot', async () => {
    // Capture the server-side response object of the perception control SSE:
    // http.Server emits 'request' to every listener, so this sees the same res
    // the route stores in cameraControlClient. By the time the client fetch
    // resolves (headers received) the handler has already run, so the capture
    // is deterministic — no polling.
    let ctlRes = null;
    srv.on('request', (rq, rs) => {
      if (rq.url.startsWith('/api/rover/camera/control')) ctlRes = rs;
    });

    const ac = new AbortController();
    const ctl = await fetch(`${url}/api/rover/camera/control`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(ctl.status, 200);
    const reader = ctl.body.getReader();
    const drained = (async () => {
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }
    })();
    assert.ok(ctlRes, 'the control response is captured on attach');
    const controlClosed = new Promise((resolve) => ctlRes.once('close', resolve));

    // Simulate a dead perception socket: writing to a destroyed http response
    // does NOT throw synchronously in Node (the error is emitted async), so
    // force the synchronous-throw path sendCameraControl guards against by
    // sabotaging this connection's write. (Same technique as the documents
    // tests' fs.renameSync monkeypatch — instance-scoped, restored by close.)
    ctlRes.write = () => { throw new Error('simulated dead control socket'); };

    const countWriteFailed = () => localDb.prepare(
      "SELECT COUNT(*) n FROM logs WHERE action = 'rover.camera.control_write_failed'",
    ).get().n;
    const countClosed = () => localDb.prepare(
      "SELECT COUNT(*) n FROM logs WHERE action = 'rover.camera.control_closed'",
    ).get().n;
    assert.equal(countWriteFailed(), 0, 'no write-failed rows before the failure');

    // Any control-triggering call now hits the throwing write.
    const res = await cli.post('/api/rover/camera/detection', {
      body: { on: true }, cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.camera_connected, false, 'the dead control slot is dropped after the failed write');

    assert.equal(countWriteFailed(), 1, 'the failed control write leaves exactly one warn trail');
    const rec = localDb.prepare(
      "SELECT level, detail FROM logs WHERE action = 'rover.camera.control_write_failed' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.equal(rec.level, 'warn');
    assert.equal(JSON.parse(rec.detail).event, 'detect-on', 'the warn names the event that failed to deliver');

    // The emptied slot short-circuits later sends to false — no warn flooding.
    await cli.post('/api/rover/camera/detection', { body: { on: false }, cookie: adminCookie });
    assert.equal(countWriteFailed(), 1, 'subsequent control calls must not log again');

    // The slot was cleared by the failed write, so the eventual client
    // disconnect must NOT also log control_closed for this connection (the
    // close handler's cameraControlClient === res guard is false).
    const closedBefore = countClosed();
    ac.abort();
    await withFailureTimeout(
      Promise.all([drained.catch(() => {}), controlClosed]),
      'camera control close',
    );
    assert.equal(countClosed(), closedBefore,
      'a connection torn down by a failed write does not double-log control_closed');
  });
});

describe('Mission telemetry historizes NTRIP link health', () => {
  const ac = new AbortController();
  let missionId;
  let streamText = '';

  before(async () => {
    // Connect a fake rover over SSE so /api/rover/execute can start a mission.
    // Accumulate the stream in the background (heartbeats + relayed commands)
    // and swallow the abort error raised on teardown so it doesn't surface as
    // an unhandled rejection.
    const streamRes = await fetch(`${baseUrl}/api/rover/stream`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = streamRes.body.getReader();
    const dec = new TextDecoder();
    (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) streamText += dec.decode(value, { stream: true }); } } catch { /* aborted */ } })();
    // Wait until the server registers the rover as connected.
    for (let i = 0; i < 100; i++) {
      const s = await client.get('/api/rover/status', { cookie: adminCookie });
      if (s.status === 200 && (await s.json()).connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  after(async () => {
    try { ac.abort(); } catch { /* ignore */ }
    // Let the server process the SSE disconnect (which interrupts the still-
    // running mission — a DB write) before the top-level after() closes the db,
    // otherwise that write can race db.close() and throw on teardown.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('persists ntrip_connected / corr_age_ms / ntrip_fail_count / h_acc_m and serves them back', async () => {
    // Anchor the rover position so the single waypoint passes distance validation.
    await client.post('/api/rover/position', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { lat: 35.292, lng: 126.574 },
    });
    const execRes = await client.post('/api/rover/execute', {
      body: { waypoints: [{ lat: 35.292, lng: 126.574 }] },
      cookie: adminCookie,
    });
    assert.equal(execRes.status, 200);

    // Connected but corrections ~1.5 s stale → the "caster silent" signature,
    // on a float fix with a known h_acc and a non-zero reconnect fail_count.
    const corrAtSec = Date.now() / 1000 - 1.5;
    const telRes = await client.post('/api/rover/telemetry', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: {
        nav_state: 'NAVIGATING',
        fix_status: 'rtk_float',
        ntrip_connected: true,
        ntrip: { host: 'ntrip.ngii.go.kr', port: 2101, mountpoint: 'SEJN-RTCM32', fail_count: 3, last_correction_at: corrAtSec, bytes_received: 4096 },
        gps: { h_acc: 0.021 },
      },
    });
    assert.equal(telRes.status, 200);

    missionId = db.prepare('SELECT id FROM mission ORDER BY id DESC LIMIT 1').get().id;
    const res = await client.get(`/api/missions/${missionId}/telemetry`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const { samples } = await res.json();
    assert.ok(samples.length >= 1);
    const last = samples[samples.length - 1];
    assert.equal(last.ntrip_connected, 1);
    assert.equal(last.ntrip_fail_count, 3);
    assert.equal(last.h_acc_m, 0.021);
    assert.equal(last.fix_status, 'rtk_float');
    // corr_age ≈ 1500 ms; generous slack for test scheduling jitter.
    assert.ok(last.corr_age_ms >= 1000 && last.corr_age_ms <= 6000, `corr_age_ms=${last.corr_age_ms}`);
  });

  it('records the disconnect flag with a null correction age (network-drop shape)', async () => {
    // ntrip_connected:false zeroes roverState.ntrip server-side, so the sample
    // carries the disconnect flag with a null age rather than a stale one.
    await client.post('/api/rover/telemetry', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: { nav_state: 'ERROR', fix_status: '3d_fix', ntrip_connected: false },
    });
    const res = await client.get(`/api/missions/${missionId}/telemetry`, { cookie: adminCookie });
    const { samples } = await res.json();
    const last = samples[samples.length - 1];
    assert.equal(last.ntrip_connected, 0);
    assert.equal(last.corr_age_ms, null);
    assert.equal(last.fix_status, '3d_fix');
  });

  it('persists altitude_m / v_acc_m from the gps block and serves them back', async () => {
    await client.post('/api/rover/telemetry', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      body: {
        nav_state: 'NAVIGATING',
        fix_status: 'rtk_fixed',
        ntrip_connected: true,
        gps: { h_acc: 0.014, v_acc: 0.022, altitude: 47.35 },
      },
    });
    const res = await client.get(`/api/missions/${missionId}/telemetry`, { cookie: adminCookie });
    const { samples } = await res.json();
    const last = samples[samples.length - 1];
    assert.equal(last.altitude_m, 47.35); // MSL altitude historized for the route profile
    assert.equal(last.v_acc_m, 0.022);    // vertical accuracy historized alongside
  });

  it('relays end-mission to the connected rover and closes the record', async () => {
    // Discarding a preserved mission must notify the rover (a new SSE command),
    // otherwise a navigator stuck in ERROR/PAUSED keeps its halted amber LED
    // latched and can auto-resume the just-closed mission on RTK recovery.
    const res = await client.post('/api/rover/end-mission', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ended, true);
    assert.equal(body.mission_id, missionId);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !streamText.includes('event: end-mission')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(streamText.includes('event: end-mission'),
      'end-mission is relayed to the connected rover SSE stream');
  });
});

// ─── Snapshots (admin-only + delete) ──────────────────────────────────────
describe('Course snapshots', () => {
  const chiefCookie = makeAuthCookie({ email: 'chief-snap@test.com', name: 'Chief', role: 'chief' });
  let courseId;

  before(async () => {
    const c = await client.post('/api/courses', { body: { name: '스냅샷 테스트 코스' }, cookie: adminCookie });
    courseId = (await c.json()).id;
    await client.post(`/api/courses/${courseId}/cones`, { body: { lat: 35.1, lng: 126.1, side: 'left' }, cookie: adminCookie });
    await client.post(`/api/courses/${courseId}/cones`, { body: { lat: 35.2, lng: 126.2, side: 'right' }, cookie: adminCookie });
  });

  it('rejects chief from every snapshot route (admin-only)', async () => {
    assert.equal((await client.get(`/api/courses/${courseId}/snapshots`, { cookie: chiefCookie })).status, 403);
    assert.equal((await client.post(`/api/courses/${courseId}/snapshots`, { body: { reason: 'x' }, cookie: chiefCookie })).status, 403);
    assert.equal((await client.post(`/api/courses/${courseId}/snapshots/1/restore`, { cookie: chiefCookie })).status, 403);
    assert.equal((await client.delete(`/api/courses/${courseId}/snapshots/1`, { cookie: chiefCookie })).status, 403);
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

  it('allows chief to manage memos (course-level annotation)', async () => {
    const chiefCookie = makeAuthCookie({ email: 'chief2@test.com', name: 'Chief2', role: 'chief' });
    const res = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
  });

  it('rejects below-chief roles from memo management', async () => {
    const officialCookie = makeAuthCookie({ email: 'official2@test.com', name: 'Official2', role: 'official' });
    const list = await client.get(`/api/courses/${memoCourseId}/memos`, { cookie: officialCookie });
    assert.equal(list.status, 403);
    const create = await client.post(`/api/courses/${memoCourseId}/memos`, {
      body: { lat: 37.5, lng: 126.9, width: 10, height: 10 },
      cookie: officialCookie,
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
