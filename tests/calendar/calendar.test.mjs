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
import { createCalendarApp } from '../../calendar/index.mjs';

/* ============================================
   Setup
   ============================================ */
setupTestEnv();

let server, baseUrl, client, db, dbPath;
const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const managerCookie = makeAuthCookie({
  email: 'calendar-manager@test.com',
  name: 'Calendar Manager',
  role: 'official',
  permissions: ['calendar.manage'],
});
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

before(async () => {
  dbPath = tmpDbPath();
  const result = createCalendarApp({ dbPath, validateUser: TRUST_JWT });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  cleanup(dbPath);
});

/* ============================================
   Tests
   ============================================ */

describe('Calendar API', () => {

  describe('GET /api/health', () => {
    it('returns ok', async () => {
      const res = await client.get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });
  });

  describe('Auth - role enforcement', () => {
    it('denies official from creating events', async () => {
      const res = await client.post('/api/events', {
        cookie: officialCookie,
        body: { title: 'Test', start: '2026-06-01', end: '2026-06-01', allDay: true },
      });
      assert.equal(res.status, 403);
    });

  });

  describe('Role validation on write endpoints', () => {
    it('rejects invalid role value on create', async () => {
      const res = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'Bad Role', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'superadmin' },
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /공개 범위/);
    });

    it('rejects invalid role value on update', async () => {
      const create = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'To Update', start: '2026-08-01', end: '2026-08-01', allDay: true },
      });
      const { id } = await create.json();
      const res = await client.put(`/api/events/${id}`, {
        cookie: managerCookie,
        body: { title: 'To Update', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'hacker' },
      });
      assert.equal(res.status, 400);
    });

    it('accepts exactly public, student, and official audiences', async () => {
      for (const role of ['public', 'student', 'official']) {
        const res = await client.post('/api/events', {
          cookie: managerCookie,
          body: { title: `${role} audience`, start: '2026-08-01', end: '2026-08-01', allDay: true, role },
        });
        assert.equal(res.status, 201);
      }

      for (const role of ['staff', 'chief', 'master', 'admin']) {
        const res = await client.post('/api/events', {
          cookie: adminCookie,
          body: { title: `${role} retired audience`, start: '2026-08-01', end: '2026-08-01', allDay: true, role },
        });
        assert.equal(res.status, 400);
      }
    });
  });

  describe('Role-based event filtering', () => {
    const visibilityPrefix = 'Visibility fixture: ';
    const roles = ['public', 'student', 'official'];

    before(async () => {
      for (const role of roles) {
        const res = await client.post('/api/events', {
          cookie: adminCookie,
          body: {
            title: `${visibilityPrefix}${role}`,
            start: '2026-10-01',
            end: '2026-10-01',
            allDay: true,
            role,
          },
        });
        assert.equal(res.status, 201, `failed to create ${role} visibility fixture`);
      }
    });

    const fixtureRoles = (events) => events
      .filter((event) => event.title.startsWith(visibilityPrefix))
      .map((event) => event.calendarId)
      .sort();

    it('unauthenticated users see only public events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31');
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.deepEqual(fixtureRoles(events), ['public']);
    });

    it('student sees only public and student events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: studentCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.deepEqual(fixtureRoles(events), ['public', 'student']);
    });

    it('official sees public, student, and official events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: officialCookie });
      assert.equal(res.status, 200);
      assert.deepEqual(fixtureRoles(await res.json()), ['official', 'public', 'student']);
    });

    it('admin sees every audience', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.deepEqual(fixtureRoles(events), ['official', 'public', 'student']);
    });
  });

  describe('GET /api/events', () => {
    it('requires timeMin and timeMax', async () => {
      const res = await client.get('/api/events', { cookie: officialCookie });
      assert.equal(res.status, 400);
    });

    it('includes all-day events when range bounds are ISO timestamps', async () => {
      const create = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'ISO Bound All Day', start: '2026-09-03', end: '2026-09-03', allDay: true },
      });
      assert.equal(create.status, 201);

      const res = await client.get('/api/events?timeMin=2026-09-02T15:00:00.000Z&timeMax=2026-09-03T14:59:59.999Z', { cookie: officialCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.ok(events.some(e => e.title === 'ISO Bound All Day'));
    });
  });

  describe('CRUD operations', () => {
    let createdId;

    it('POST /api/events - creates an all-day event', async () => {
      const res = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'Technical Inspection', start: '2026-07-15', end: '2026-07-16', allDay: true, location: 'KARA Track' },
      });
      assert.equal(res.status, 201);
      const event = await res.json();
      assert.ok(event.id);
      assert.equal(event.title, 'Technical Inspection');
      assert.equal(event.location, 'KARA Track');
      createdId = event.id;
    });

    it('POST /api/events - creates a timed event', async () => {
      const res = await client.post('/api/events', {
        cookie: managerCookie,
        body: {
          title: 'Design Event',
          start: '2026-07-15 09:00',
          end: '2026-07-15 17:00',
          allDay: false,
          description: 'Design presentation',
        },
      });
      assert.equal(res.status, 201);
      const event = await res.json();
      assert.equal(event.title, 'Design Event');
      assert.equal(event.allDay, false);
    });

    it('POST /api/events - rejects missing fields', async () => {
      const res = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'No dates' },
      });
      assert.equal(res.status, 400);
    });

    it('POST /api/events - rejects start after end', async () => {
      const res = await client.post('/api/events', {
        cookie: managerCookie,
        body: { title: 'Backwards', start: '2026-07-20', end: '2026-07-15', allDay: true },
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /시작/);
    });

    it('PUT /api/events/:id - rejects start after end', async () => {
      const res = await client.put(`/api/events/${createdId}`, {
        cookie: managerCookie,
        body: { title: 'Backwards', start: '2026-07-20', end: '2026-07-15', allDay: true },
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /시작/);
    });

    it('PUT /api/events/:id - updates an event', async () => {
      const res = await client.put(`/api/events/${createdId}`, {
        cookie: managerCookie,
        body: { title: 'Updated Inspection', start: '2026-07-16', end: '2026-07-17', allDay: true },
      });
      assert.equal(res.status, 200);
      const event = await res.json();
      assert.equal(event.title, 'Updated Inspection');
    });

    it('PUT /api/events/:id - returns 404 for non-existent event', async () => {
      const res = await client.put('/api/events/99999', {
        cookie: managerCookie,
        body: { title: 'Ghost', start: '2026-07-16', end: '2026-07-17', allDay: true },
      });
      assert.equal(res.status, 404);
    });

    it('DELETE /api/events/:id - deletes an event', async () => {
      const res = await client.delete(`/api/events/${createdId}`, { cookie: managerCookie });
      assert.equal(res.status, 204);
      const again = await client.delete(`/api/events/${createdId}`, { cookie: managerCookie });
      assert.equal(again.status, 404);
    });
  });
});
