import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../calendar/node_modules/express/index.js');
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
} from '../helpers/test-utils.mjs';
import { createCalendarApp } from '../../calendar/index.mjs';

/* ============================================
   Mock Auth Server
   ============================================ */
const MOCK_USERS = [
  { email: 'student@test.com', name: 'Student', role: 'student', active: 1 },
  { email: 'official@test.com', name: 'Official', role: 'official', active: 1 },
  { email: 'chief@test.com', name: 'Chief', role: 'chief', active: 1 },
  { email: 'admin@test.com', name: 'Admin', role: 'admin', active: 1 },
];

function createMockAuthServer() {
  const app = express();
  app.use(express.json());
  app.get('/api/users/role/:email', (req, res) => {
    const user = MOCK_USERS.find(u => u.email === decodeURIComponent(req.params.email));
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json({ role: user.role });
  });
  return app;
}

/* ============================================
   Setup
   ============================================ */
setupTestEnv();

let server, baseUrl, client, db, dbPath;
let mockAuthServer;

const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  dbPath = tmpDbPath();
  const result = createCalendarApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  await stopServer(mockAuthServer);
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
    it('allows unauthenticated access with public-only filtering', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31');
      assert.equal(res.status, 200);
      const events = await res.json();
      for (const e of events) assert.equal(e.role, 'public');
    });

    it('allows student access with public-only filtering', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: studentCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      for (const e of events) {
        assert.ok(['public', 'student'].includes(e.role));
      }
    });

    it('allows official access to events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: officialCookie });
      assert.equal(res.status, 200);
    });

    it('denies official from creating events', async () => {
      const res = await client.post('/api/events', {
        cookie: officialCookie,
        body: { title: 'Test', start: '2026-06-01', end: '2026-06-01', allDay: true },
      });
      assert.equal(res.status, 403);
    });

    it('allows chief to create events', async () => {
      const res = await client.post('/api/events', {
        cookie: chiefCookie,
        body: { title: 'Chief Event', start: '2026-06-01', end: '2026-06-01', allDay: true },
      });
      assert.equal(res.status, 201);
    });
  });

  describe('Role validation on write endpoints', () => {
    it('rejects invalid role value on create', async () => {
      const res = await client.post('/api/events', {
        cookie: chiefCookie,
        body: { title: 'Bad Role', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'superadmin' },
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /Invalid role/i);
    });

    it('rejects invalid role value on update', async () => {
      const create = await client.post('/api/events', {
        cookie: chiefCookie,
        body: { title: 'To Update', start: '2026-08-01', end: '2026-08-01', allDay: true },
      });
      const { id } = await create.json();
      const res = await client.put(`/api/events/${id}`, {
        cookie: chiefCookie,
        body: { title: 'To Update', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'hacker' },
      });
      assert.equal(res.status, 400);
    });

    it('prevents chief from setting admin-level visibility', async () => {
      const res = await client.post('/api/events', {
        cookie: chiefCookie,
        body: { title: 'Admin Only', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'admin' },
      });
      assert.equal(res.status, 403);
    });

    it('allows admin to set admin-level visibility', async () => {
      const res = await client.post('/api/events', {
        cookie: adminCookie,
        body: { title: 'Admin Event', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'admin' },
      });
      assert.equal(res.status, 201);
    });

    it('allows chief to set chief-level visibility', async () => {
      const res = await client.post('/api/events', {
        cookie: chiefCookie,
        body: { title: 'Chief Event 2', start: '2026-08-01', end: '2026-08-01', allDay: true, role: 'chief' },
      });
      assert.equal(res.status, 201);
    });
  });

  describe('Role-based event filtering', () => {
    it('unauthenticated users see only public events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31');
      assert.equal(res.status, 200);
      const events = await res.json();
      for (const e of events) {
        assert.equal(e.calendarId, 'public', `unexpected role: ${e.calendarId} for "${e.title}"`);
      }
    });

    it('student sees only public and student events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: studentCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      const allowed = ['public', 'student'];
      for (const e of events) {
        assert.ok(allowed.includes(e.calendarId), `student should not see role: ${e.calendarId}`);
      }
    });

    it('admin sees all events including admin-role events', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      const roles = new Set(events.map(e => e.calendarId));
      assert.ok(roles.has('admin'), 'admin should see admin-role events');
    });
  });

  describe('GET /api/events', () => {
    it('requires timeMin and timeMax', async () => {
      const res = await client.get('/api/events', { cookie: officialCookie });
      assert.equal(res.status, 400);
    });

    it('returns events list', async () => {
      const res = await client.get('/api/events?timeMin=2026-01-01&timeMax=2026-12-31', { cookie: officialCookie });
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.ok(Array.isArray(events));
      assert.ok(events.length >= 1);
    });
  });

  describe('CRUD operations', () => {
    let createdId;

    it('POST /api/events - creates an all-day event', async () => {
      const res = await client.post('/api/events', {
        cookie: chiefCookie,
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
        cookie: chiefCookie,
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
        cookie: chiefCookie,
        body: { title: 'No dates' },
      });
      assert.equal(res.status, 400);
    });

    it('PUT /api/events/:id - updates an event', async () => {
      const res = await client.put(`/api/events/${createdId}`, {
        cookie: chiefCookie,
        body: { title: 'Updated Inspection', start: '2026-07-16', end: '2026-07-17', allDay: true },
      });
      assert.equal(res.status, 200);
      const event = await res.json();
      assert.equal(event.title, 'Updated Inspection');
    });

    it('PUT /api/events/:id - returns 404 for non-existent event', async () => {
      const res = await client.put('/api/events/99999', {
        cookie: chiefCookie,
        body: { title: 'Ghost', start: '2026-07-16', end: '2026-07-17', allDay: true },
      });
      assert.equal(res.status, 404);
    });

    it('DELETE /api/events/:id - deletes an event', async () => {
      const res = await client.delete(`/api/events/${createdId}`, { cookie: chiefCookie });
      assert.equal(res.status, 204);
    });

    it('DELETE /api/events/:id - returns 404 for non-existent event', async () => {
      const res = await client.delete('/api/events/99999', { cookie: chiefCookie });
      assert.equal(res.status, 404);
    });
  });
});
