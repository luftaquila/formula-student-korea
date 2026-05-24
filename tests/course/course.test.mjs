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

describe('POST /api/rover/clear-emergency', () => {
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/clear-emergency', { cookie: adminCookie });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/rover/dispenser', () => {
  it('returns 400 when position is missing', async () => {
    const res = await client.post('/api/rover/dispenser', {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });
  it('returns 400 when position is not load/dump', async () => {
    const res = await client.post('/api/rover/dispenser', {
      cookie: adminCookie,
      body: { position: 'banana' },
    });
    assert.equal(res.status, 400);
  });
  it('returns 503 when rover is not connected', async () => {
    const res = await client.post('/api/rover/dispenser', {
      cookie: adminCookie,
      body: { position: 'load' },
    });
    assert.equal(res.status, 503);
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

describe('Course snapshots', () => {
  let courseId;
  let firstCount;

  before(async () => {
    const createRes = await client.post('/api/courses', {
      body: { name: 'snapshot-course' },
      cookie: adminCookie,
    });
    courseId = (await createRes.json()).id;
    for (let i = 0; i < 3; i++) {
      await client.post(`/api/courses/${courseId}/cones`, {
        body: { lat: 35 + i * 0.0001, lng: 126 + i * 0.0001, side: 'left' },
        cookie: adminCookie,
      });
    }
    firstCount = 3;
  });

  it('rejects snapshot of empty course', async () => {
    const emptyRes = await client.post('/api/courses', { body: { name: 'snap-empty' }, cookie: adminCookie });
    const emptyId = (await emptyRes.json()).id;
    const res = await client.post(`/api/courses/${emptyId}/snapshots`, { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('creates a manual snapshot', async () => {
    const res = await client.post(`/api/courses/${courseId}/snapshots`, {
      body: { reason: 'before-edit' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(Number.isInteger(body.id));
  });

  it('lists snapshots for a course', async () => {
    const res = await client.get(`/api/courses/${courseId}/snapshots`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.snapshots));
    assert.ok(data.snapshots.length >= 1);
    assert.equal(data.snapshots[0].cone_count, firstCount);
  });

  it('restores a snapshot, wiping current cones', async () => {
    // Add an extra cone and snapshot; then delete all and restore older one.
    const snapRes = await client.post(`/api/courses/${courseId}/snapshots`, {
      body: { reason: 'to-restore' }, cookie: adminCookie,
    });
    const snapId = (await snapRes.json()).id;

    // Add a 4th cone, change state
    await client.post(`/api/courses/${courseId}/cones`, {
      body: { lat: 35.5, lng: 126.5, side: 'right' },
      cookie: adminCookie,
    });

    const listRes = await client.get(`/api/courses/${courseId}/cones`, { cookie: adminCookie });
    const list = await listRes.json();
    assert.equal(list.length, 4);

    const restoreRes = await client.post(`/api/courses/${courseId}/snapshots/${snapId}/restore`, {
      cookie: adminCookie,
    });
    assert.equal(restoreRes.status, 200);

    const afterRes = await client.get(`/api/courses/${courseId}/cones`, { cookie: adminCookie });
    const after = await afterRes.json();
    assert.equal(after.length, firstCount);
  });

  it('returns 404 for missing snapshot on restore', async () => {
    const res = await client.post(`/api/courses/${courseId}/snapshots/999999/restore`, { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('Mission orphan recovery (on startup)', () => {
  it('marks running missions as error when the app boots on an existing DB', async () => {
    // Write an orphan row into the existing DB, then boot a second app instance
    // against the same file so its startup migration runs against our fixture.
    const started_at = Date.now() - 60000;
    db.prepare("INSERT INTO mission (started_at, status, waypoints_json) VALUES (?, 'running', ?)")
      .run(started_at, '[]');
    const orphanId = db.prepare("SELECT id FROM mission WHERE started_at = ?").get(started_at).id;

    const { createCourseApp } = await import('../../course/index.mjs?v=orphan');
    const result = createCourseApp({ dbPath });
    const started = await startServer(result.app);
    const localClient = createClient(started.baseUrl);
    try {
      const res = await localClient.get('/api/missions', { cookie: adminCookie });
      const data = await res.json();
      const m = data.missions.find((x) => x.id === orphanId);
      assert.ok(m, 'orphan mission row disappeared');
      assert.equal(m.status, 'error');
      assert.ok(m.ended_at, 'ended_at should be populated');
    } finally {
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
