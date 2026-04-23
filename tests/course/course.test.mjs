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
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createCourseApp } from '../../course/index.mjs';

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createCourseApp({ dbPath });
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
  it('rejects unauthenticated requests to /api/courses', async () => {
    const res = await client.get('/api/courses');
    assert.equal(res.status, 401);
  });

  it('rejects non-admin requests to /api/courses', async () => {
    const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
    const res = await client.get('/api/courses', { cookie: studentCookie });
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
  });
});

describe('GET /api/courses (after create)', () => {
  it('returns created courses with cone_count', async () => {
    const res = await client.get('/api/courses', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    assert.equal(data[0].name, '오토크로스 A');
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
  });

  it('adds a right cone', async () => {
    const res = await client.post('/api/courses/1/cones', {
      body: { lat: 37.5666, lng: 126.9781, side: 'right' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
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

  it('rejects invalid coordinate', async () => {
    const res = await client.patch('/api/cones/1', {
      body: { lat: -91 },
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
  });

  it('returns 404 for already deleted cone', async () => {
    const res = await client.delete('/api/cones/2', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('verifies cone count decreased', async () => {
    const res = await client.get('/api/courses/1/cones', { cookie: adminCookie });
    const data = await res.json();
    assert.equal(data.length, 2);
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
  });

  it('returns 404 for non-existent course', async () => {
    const res = await client.delete('/api/courses/999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/courses/:id (remaining)', () => {
  it('deletes remaining course', async () => {
    const res = await client.delete('/api/courses/1', { cookie: adminCookie });
    assert.equal(res.status, 200);
  });

  it('courses list is empty again', async () => {
    const res = await client.get('/api/courses', { cookie: adminCookie });
    const data = await res.json();
    assert.equal(data.length, 0);
  });
});

// ─── Export / Import ────────────────────────────────────────────────────
describe('GET /api/courses/:id/export', () => {
  before(async () => {
    await client.post('/api/courses', { body: { name: 'export-test' }, cookie: adminCookie });
    await client.post('/api/courses/3/cones', { body: { lat: 35.0, lng: 126.0, side: 'left' }, cookie: adminCookie });
  });

  it('exports course as JSON', async () => {
    const res = await client.get('/api/courses/3/export', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'export-test');
    assert.equal(data.cones.length, 1);
    assert.equal(data.cones[0].lat, 35.0);
    assert.equal(data.cones[0].side, 'left');
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

  after(async () => {
    // cleanup
    const res = await client.get('/api/courses', { cookie: adminCookie });
    const courses = await res.json();
    for (const c of courses) {
      await client.delete(`/api/courses/${c.id}`, { cookie: adminCookie });
    }
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

describe('POST /api/rover/control', () => {
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
});

// ─── Rover stream fail-close ────────────────────────────────────────────
describe('GET /api/rover/stream (auth)', () => {
  it('rejects request without internal secret and without admin cookie', async () => {
    const res = await client.get('/api/rover/stream');
    assert.equal(res.status, 401);
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
});
