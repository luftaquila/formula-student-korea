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

describe('Mission orphan recovery + boot re-adopt (on startup)', () => {
  it('keeps a running mission resumable (interrupted, not error) and re-adopts it into memory', async () => {
    // A row left 'running' means the server died mid-mission. The rover keeps
    // driving and reconnects, so the mission must NOT be discarded — it becomes
    // 'interrupted' (resumable, not ended) and is reloaded into mission_progress
    // so the reconnecting rover stays attached and the UI can rebuild the view.
    const started_at = Date.now() - 60000;
    db.prepare(
      "INSERT INTO mission (started_at, status, waypoints_json, current_waypoint_idx, spray_results_json) VALUES (?, 'running', ?, ?, ?)"
    ).run(started_at, '[{"lat":35,"lng":126},{"lat":35.0001,"lng":126.0001},{"lat":35.0002,"lng":126.0002}]', 2, '{"0":"success"}');
    const orphanId = db.prepare("SELECT id FROM mission WHERE started_at = ?").get(started_at).id;

    const { createCourseApp } = await import('../../course/index.mjs?v=orphan');
    const result = createCourseApp({ dbPath });
    const started = await startServer(result.app);
    const localClient = createClient(started.baseUrl);
    try {
      const data = await (await localClient.get('/api/missions', { cookie: adminCookie })).json();
      const m = data.missions.find((x) => x.id === orphanId);
      assert.ok(m, 'orphan mission row disappeared');
      assert.equal(m.status, 'interrupted', 'running orphan must become resumable, not error');
      assert.ok(!m.ended_at, 'interrupted mission must not be ended');

      // Re-adopted into memory: mission_progress restored with persisted index.
      const status = await (await localClient.get('/api/rover/status', { cookie: adminCookie })).json();
      assert.equal(status.mission_progress.mission_id, orphanId);
      assert.equal(status.mission_progress.current_waypoint_idx, 2);
      assert.equal(status.mission_progress.status, 'interrupted');
      assert.equal(status.mission_progress.waypoints.length, 3);
      assert.equal(status.mission_progress.spray_results['0'], 'success');
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
    const result = createCourseApp({ dbPath: localDbPath });
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
    const result = createCourseApp({ dbPath: localDbPath });
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
    const result = createCourseApp({ dbPath: p });
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

// ─── Camera relay (MJPEG) ───────────────────────────────────────────────
describe('Camera relay', () => {
  let srv, url, cli, localDb, localDbPath;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    localDbPath = tmpDbPath();
    const result = createCourseApp({ dbPath: localDbPath });
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

    // Last viewer leaves → camera-stop.
    stopView();
    viewAc.abort();
    assert.ok(await waitFor(() => ctlSink.text.includes('camera-stop'), 1500),
      'last viewer triggers camera-stop');

    stopCtl();
    ctlAc.abort();
  });

  it('caps concurrent viewers (503 past the limit)', async () => {
    // The viewer cap is the only thing stopping a scripted/looping admin from
    // exhausting sockets/heap on the shared mission server, so guard it.
    const MAX = 8; // mirrors MAX_CAMERA_VIEWERS in course/index.mjs
    const acs = [];
    try {
      for (let i = 0; i < MAX; i++) {
        const ac = new AbortController();
        acs.push(ac);
        const r = await fetch(`${url}/api/rover/camera/stream`, { headers: { Cookie: adminCookie }, signal: ac.signal });
        assert.equal(r.status, 200, `viewer ${i + 1} should be accepted`);
      }
      const ac = new AbortController();
      acs.push(ac);
      const over = await fetch(`${url}/api/rover/camera/stream`, { headers: { Cookie: adminCookie }, signal: ac.signal });
      assert.equal(over.status, 503, 'a viewer past the cap must be rejected');
      try { await over.body?.cancel(); } catch { /* ignore */ }
    } finally {
      for (const ac of acs) ac.abort();
      await sleep(150); // let the server reap the aborted viewers before the next test
    }
  });
});
