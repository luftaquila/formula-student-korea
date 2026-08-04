import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../documents/node_modules/express/index.js');
const Database = require('../../documents/node_modules/better-sqlite3');
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
import { createDocumentsApp } from '../../documents/index.mjs';

/* ============================================
   Mock Auth Server
   ============================================ */
const MOCK_USERS = [
  { email: 'student1@test.com', name: 'Student 1', role: 'student', active: 1 },
  { email: 'student2@test.com', name: 'Student 2', role: 'student', active: 1 },
  { email: 'official@test.com', name: 'Official', role: 'official', active: 1 },
  { email: 'chief@test.com', name: 'Chief', role: 'chief', active: 1 },
  { email: 'admin@test.com', name: 'Admin', role: 'admin', active: 1 },
];

function createMockAuthServer() {
  const app = express();
  app.use(express.json());
  app.get('/api/users', (req, res) => {
    res.json(MOCK_USERS);
  });
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

let server, baseUrl, client, db, dbPath, uploadsDir;
let mockAuthServer;

const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const studentCookie = makeAuthCookie({ email: 'student1@test.com', name: 'Student 1', role: 'student' });
const student2Cookie = makeAuthCookie({ email: 'student2@test.com', name: 'Student 2', role: 'student' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });

describe('student_team migration', () => {
  it('migrates legacy email-only PK once and keeps composite PK on restart', () => {
    const legacyPath = tmpDbPath();
    const legacyUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE student_team (
        email TEXT PRIMARY KEY,
        team_num INTEGER NOT NULL,
        year INTEGER NOT NULL,
        UNIQUE(team_num, year)
      );
      INSERT INTO student_team (email, team_num, year) VALUES ('legacy@test.com', 7, 2026);
    `);
    legacyDb.close();

    const first = createDocumentsApp({ dbPath: legacyPath, uploadsDir: legacyUploads });
    if (first._schedulerInterval) clearInterval(first._schedulerInterval);
    if (first._renumberFileWorkInterval) clearInterval(first._renumberFileWorkInterval);
    if (first._renumberFileWorkStartupTimer) clearTimeout(first._renumberFileWorkStartupTimer);
    let info = first.db.prepare("PRAGMA table_info(student_team)").all();
    assert.equal(info.find(c => c.name === 'email').pk, 1);
    assert.equal(info.find(c => c.name === 'year').pk, 2);
    first.db.close();

    const second = createDocumentsApp({ dbPath: legacyPath, uploadsDir: legacyUploads });
    if (second._schedulerInterval) clearInterval(second._schedulerInterval);
    if (second._renumberFileWorkInterval) clearInterval(second._renumberFileWorkInterval);
    if (second._renumberFileWorkStartupTimer) clearTimeout(second._renumberFileWorkStartupTimer);
    info = second.db.prepare("PRAGMA table_info(student_team)").all();
    assert.equal(info.find(c => c.name === 'email').pk, 1);
    assert.equal(info.find(c => c.name === 'year').pk, 2);
    assert.deepEqual(second.db.prepare("SELECT email, team_num, year FROM student_team").all(), [
      { email: 'legacy@test.com', team_num: 7, year: 2026 },
    ]);
    second.db.close();
    cleanup(legacyPath);
    cleanup(legacyUploads);
  });
});

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  dbPath = tmpDbPath();
  uploadsDir = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
  const result = createDocumentsApp({ dbPath, uploadsDir });
  db = result.db;
  if (result._schedulerInterval) clearInterval(result._schedulerInterval);
  if (result._renumberFileWorkInterval) clearInterval(result._renumberFileWorkInterval);
  if (result._renumberFileWorkStartupTimer) clearTimeout(result._renumberFileWorkStartupTimer);
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  await stopServer(mockAuthServer);
  db.close();
  cleanup(dbPath);
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

/* ============================================
   Helpers
   ============================================ */
function makeMultipartBody(boundary, files) {
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
    ));
    parts.push(f.content);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

async function uploadFile(sessionId, cookie, files) {
  const boundary = '----FormBoundary' + crypto.randomUUID();
  const body = makeMultipartBody(boundary, files);
  return fetch(`${baseUrl}/api/sessions/${sessionId}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Cookie': cookie,
    },
    body,
  });
}

/* ============================================
   Tests
   ============================================ */

// -- Health --
describe('GET /api/health', () => {
  it('returns 200 "ok" (public)', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

// -- Student-team mapping (admin API) --
describe('Student-team mapping (admin API)', () => {
  it('GET /api/admin/student-teams returns empty initially', async () => {
    const res = await client.get('/api/admin/student-teams', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/admin/student-teams creates mapping', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { email: 'student1@test.com', team_num: 1, year: 2026 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.email, 'student1@test.com');
    assert.equal(data.team_num, 1);
    assert.equal(data.year, 2026);
  });

  it('POST /api/admin/student-teams validates required fields', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { team_num: 1, year: 2026 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/student-teams validates team_num', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { email: 'x@test.com', team_num: -5, year: 2026 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/student-teams validates year', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { email: 'x@test.com', team_num: 1, year: 1999 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/student-teams rejects duplicate (UNIQUE)', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { email: 'student1@test.com', team_num: 1, year: 2026 },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/admin/student-teams returns created mapping', async () => {
    const res = await client.get('/api/admin/student-teams', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].email, 'student1@test.com');
    assert.equal(data[0].team_num, 1);
  });

  it('GET /api/admin/student-teams?year=2026 filters by year', async () => {
    const res = await client.get('/api/admin/student-teams?year=2026', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].year, 2026);
  });

  it('GET /api/admin/student-teams?year=2025 returns empty for different year', async () => {
    const res = await client.get('/api/admin/student-teams?year=2025', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 0);
  });

  it('DELETE /api/admin/student-teams/:email/:year returns 404 for non-existent', async () => {
    const res = await client.delete('/api/admin/student-teams/nobody@test.com/2026', { cookie: chiefCookie });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/admin/student-teams/:email/:year deletes mapping', async () => {
    // Create a disposable mapping
    await client.post('/api/admin/student-teams', {
      body: { email: 'disposable@test.com', team_num: 99, year: 2025 },
      cookie: chiefCookie,
    });
    const res = await client.delete('/api/admin/student-teams/disposable@test.com/2025', { cookie: chiefCookie });
    assert.equal(res.status, 200);

    // Verify it's gone
    const listRes = await client.get('/api/admin/student-teams?year=2025', { cookie: chiefCookie });
    const data = await listRes.json();
    assert.equal(data.length, 0);
  });
});

// -- Admin students --
describe('GET /api/admin/students', () => {
  it('returns student users from mock auth server', async () => {
    const res = await client.get('/api/admin/students', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2); // only students, not official
    assert.ok(data.find(u => u.email === 'student1@test.com'));
    assert.ok(data.find(u => u.email === 'student2@test.com'));
    // Should not include non-student roles
    assert.ok(!data.find(u => u.email === 'official@test.com'));
  });
});

// -- Session management (admin API) --
let sessionId;

describe('Session management (admin API)', () => {
  it('GET /api/admin/sessions returns empty initially', async () => {
    const res = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/admin/sessions creates session', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Test Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 10485760,
        year: 2026,
        teams: [1],
        allowed_extensions: 'pdf,docx',
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    sessionId = data.id;
  });

  it('creates scheduled notifications when session is created', () => {
    const rows = db.prepare('SELECT type, scheduled_at FROM scheduled_notification WHERE session_id = ? ORDER BY type').all(sessionId);
    // start_at is past (2020), so session_open should be scheduled at ~now
    // end_at is 2030, so deadline_3h and deadline_1h should be scheduled
    assert.ok(rows.length >= 2, `expected >= 2 scheduled notifications, got ${rows.length}`);
    const types = rows.map(r => r.type);
    assert.ok(types.includes('deadline_3h'));
    assert.ok(types.includes('deadline_1h'));
  });

  it('POST /api/admin/sessions validates required fields (name)', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: '',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates required fields (dates)', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Missing Dates',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates required fields (teams)', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'No Teams',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates date format', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Bad Date',
        start_at: 'not-a-date',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates end > start', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'End Before Start',
        start_at: '2030-12-31T23:59',
        end_at: '2020-01-01T00:00',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates year range', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Bad Year',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 1999,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates teams array not empty', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'No Teams Array',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates team numbers', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Bad Team Numbers',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [-1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/admin/sessions validates late_end_at >= end_at', async () => {
    const res = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Invalid Late End',
        start_at: '2026-01-01T00:00',
        end_at: '2026-01-02T00:00',
        late_end_at: '2026-01-01T12:00', // before end_at
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
      },
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/admin/sessions returns created session', async () => {
    const res = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'Test Session');
    assert.equal(data[0].year, 2026);
    assert.equal(data[0].allowed_extensions, 'pdf,docx');
  });

  it('PUT /api/admin/sessions/:id updates session', async () => {
    const res = await client.put(`/api/admin/sessions/${sessionId}`, {
      body: {
        name: 'Updated Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 10485760,
        allowed_extensions: 'pdf',
        teams: [1],
      },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);

    // Verify the update
    const getRes = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    const data = await getRes.json();
    const updated = data.find(s => s.id === sessionId);
    assert.equal(updated.name, 'Updated Session');
    assert.equal(updated.allowed_extensions, 'pdf');

    // Restore original name for subsequent tests
    await client.put(`/api/admin/sessions/${sessionId}`, {
      body: {
        name: 'Test Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 10485760,
        allowed_extensions: 'pdf,docx',
        teams: [1],
      },
      cookie: chiefCookie,
    });
  });

  it('DELETE /api/admin/sessions/:id deletes session', async () => {
    // Create a disposable session
    const createRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Disposable Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    const { id } = await createRes.json();

    // Verify scheduled notifications exist before delete
    const beforeCount = db.prepare('SELECT count(*) as c FROM scheduled_notification WHERE session_id = ?').get(id).c;
    assert.ok(beforeCount > 0, 'scheduled notifications should exist before delete');

    const res = await client.delete(`/api/admin/sessions/${id}`, { cookie: chiefCookie });
    assert.equal(res.status, 200);

    // Verify it's gone
    const listRes = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    const data = await listRes.json();
    assert.ok(!data.find(s => s.id === id));

    // Verify scheduled notifications cascaded
    const afterCount = db.prepare('SELECT count(*) as c FROM scheduled_notification WHERE session_id = ?').get(id).c;
    assert.equal(afterCount, 0, 'scheduled notifications should cascade on session delete');
  });
});

// -- Session status --
describe('GET /api/admin/sessions/:id/status', () => {
  it('returns team submission status', async () => {
    const res = await client.get(`/api/admin/sessions/${sessionId}/status`, { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.session);
    assert.equal(data.session.id, sessionId);
    assert.ok(Array.isArray(data.status));
    assert.equal(data.status.length, 1);
    assert.equal(data.status[0].team_num, 1);
    assert.equal(data.status[0].submission, null);
  });

  it('returns 404 for non-existent session', async () => {
    const res = await client.get('/api/admin/sessions/99999/status', { cookie: chiefCookie });
    assert.equal(res.status, 404);
  });
});

// -- Student API (sessions list) --
describe('Student API - sessions list', () => {
  it('GET /api/sessions returns sessions for student team', async () => {
    // student1 is already mapped to team 1, year 2026
    const res = await client.get('/api/sessions', { cookie: studentCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.team);
    assert.equal(data.team.team_num, 1);
    assert.equal(data.team.year, 2026);
    assert.ok(Array.isArray(data.sessions));
    assert.ok(data.sessions.length >= 1);
    assert.ok(data.sessions.find(s => s.id === sessionId));
  });

  it('GET /api/sessions returns { team: null, sessions: [] } if no mapping', async () => {
    const res = await client.get('/api/sessions', { cookie: student2Cookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.team, null);
    assert.deepEqual(data.sessions, []);
  });
});

// -- Student API (session detail) --
describe('Student API - session detail', () => {
  it('GET /api/sessions/:id returns session details for target team', async () => {
    const res = await client.get(`/api/sessions/${sessionId}`, { cookie: studentCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.session);
    assert.equal(data.session.id, sessionId);
    assert.equal(data.team_num, 1);
    assert.equal(data.submission, null);
    assert.deepEqual(data.files, []);
  });

  it('GET /api/sessions/:id returns 403 if not target team', async () => {
    // student2 has no team mapping, so gets 403
    const res = await client.get(`/api/sessions/${sessionId}`, { cookie: student2Cookie });
    assert.equal(res.status, 403);
  });

  it('GET /api/sessions/:id returns 404 for non-existent session', async () => {
    const res = await client.get('/api/sessions/99999', { cookie: studentCookie });
    assert.equal(res.status, 404);
  });

  it('GET/POST /api/sessions/:id reject a same-number team from a different year (cross-year IDOR)', async () => {
    // student1 is team 1 / 2026. Team numbers are reused across years for
    // different universities, so a 2025 session that also lists team 1 must NOT
    // be readable or submittable by the 2026 team-1 student.
    const createRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Prev-year Session',
        start_at: '2020-01-01T00:00', end_at: '2030-12-31T23:59', late_end_at: '',
        max_file_size: 10485760, year: 2025, teams: [1], allowed_extensions: 'pdf',
      },
      cookie: chiefCookie,
    });
    assert.equal(createRes.status, 201);
    const otherYearId = (await createRes.json()).id;

    const view = await client.get(`/api/sessions/${otherYearId}`, { cookie: studentCookie });
    assert.equal(view.status, 403, 'must not read a different-year session with a matching team number');

    const submit = await uploadFile(otherYearId, studentCookie, [
      { name: 'x.pdf', type: 'application/pdf', content: Buffer.from('x') },
    ]);
    assert.equal(submit.status, 403, 'must not submit to a different-year session');

    db.prepare('DELETE FROM session WHERE id = ?').run(otherYearId);
  });
});

// -- File upload (submit) --
let submissionId, fileId;

describe('File upload', () => {
  it('POST /api/sessions/:id/submit uploads file', async () => {
    const fileContent = Buffer.from('test file content for pdf');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'test.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    assert.ok(data.submitted_at);
    submissionId = data.id;
  });

  it('POST /api/sessions/:id/submit rejects wrong extension', async () => {
    // Session has allowed_extensions: 'pdf,docx'
    const fileContent = Buffer.from('test exe content');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'test.exe', type: 'application/octet-stream', content: fileContent },
    ]);
    assert.equal(res.status, 400);

    // rejection must be logged (CLAUDE.md logging policy)
    const log = db.prepare(
      "SELECT * FROM logs WHERE action = 'submission.create' AND level = 'warn' AND detail LIKE '%invalid_extension%' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(log, 'extension rejection should be logged');
    assert.match(log.detail, /test\.exe/);
  });

  it('POST /api/sessions/:id/submit allows docx extension', async () => {
    const fileContent = Buffer.from('test docx content');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'test.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: fileContent },
    ]);
    assert.equal(res.status, 200);
    const data = await res.json();
    submissionId = data.id; // update to latest submission
  });

  it('POST /api/sessions/:id/submit automatically detects ambiguous CP949 Korean text', async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Text Encoding Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 10485760,
        year: 2026,
        teams: [1],
        allowed_extensions: 'txt',
      },
      cookie: chiefCookie,
    });
    assert.equal(sessionRes.status, 201);
    const { id: textSessionId } = await sessionRes.json();

    try {
      const res = await uploadFile(textSessionId, studentCookie, [
        // CP949 "책 1\n째 1\n짱징책", but also valid UTF-8 "å 1\n° 1\n¯¡å".
        { name: 'ambiguous.txt', type: 'text/plain', content: Buffer.from([0xc3, 0xa5, 0x20, 0x31, 0x0a, 0xc2, 0xb0, 0x20, 0x31, 0x0a, 0xc2, 0xaf, 0xc2, 0xa1, 0xc3, 0xa5]) },
      ]);
      assert.equal(res.status, 200);
      const data = await res.json();
      const file = db.prepare('SELECT id, text_charset FROM submission_file WHERE submission_id = ?').get(data.id);
      assert.equal(file.text_charset, 'euc-kr');

      const normalRes = await fetch(`${baseUrl}/api/admin/submissions/${data.id}/files/${file.id}`, {
        headers: { 'Cookie': adminCookie },
      });
      assert.equal(normalRes.headers.get('content-type'), 'text/plain; charset=euc-kr');
      const body = Buffer.from(await normalRes.arrayBuffer());
      assert.equal(new TextDecoder('euc-kr').decode(body), '책 1\n째 1\n짱징책');
    } finally {
      await client.delete(`/api/admin/sessions/${textSessionId}`, { cookie: chiefCookie });
    }
  });

  it('POST /api/sessions/:id/submit 403 if not target team', async () => {
    const fileContent = Buffer.from('unauthorized content');
    const res = await uploadFile(sessionId, student2Cookie, [
      { name: 'test.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 403);
  });

  it('POST /api/sessions/:id/submit keeps previous submission (2-set retention)', async () => {
    const prevSubId = submissionId;
    const fileContent = Buffer.from('replacement file content');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'replacement.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    assert.notEqual(data.id, prevSubId);
    submissionId = data.id;

    // Previous submission should still exist (2-set retention)
    const prevSub = db.prepare('SELECT * FROM submission WHERE id = ?').get(prevSubId);
    assert.ok(prevSub, 'previous submission should be kept');
  });

  it('POST /api/sessions/:id/submit accepts uppercase extension (.PDF matches .pdf)', async () => {
    // Create a session allowing only pdf
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Case Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
        allowed_extensions: 'pdf',
      },
    });
    const { id } = await sessionRes.json();

    // Upload with .PDF extension (uppercase)
    // The code does ext.toLowerCase(), so .PDF should match .pdf
    const fileContent = Buffer.from('uppercase extension pdf content');
    const res = await uploadFile(id, studentCookie, [
      { name: 'TEST.PDF', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 200);

    // Cleanup
    await client.delete(`/api/admin/sessions/${id}`, { cookie: chiefCookie });
  });

  it('POST /api/sessions/:id/submit rejects if before start_at', async () => {
    // Create a session that starts in the far future
    const futureRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Future Session',
        start_at: '2099-01-01T00:00',
        end_at: '2099-12-31T23:59',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    const { id: futureId } = await futureRes.json();

    const fileContent = Buffer.from('too early');
    const res = await uploadFile(futureId, studentCookie, [
      { name: 'test.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 400);

    // Cleanup
    await client.delete(`/api/admin/sessions/${futureId}`, { cookie: chiefCookie });
  });

  it('POST /api/sessions/:id/submit rejects if after late_end_at', async () => {
    // Create a session that ended in the past
    const pastRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Past Session',
        start_at: '2000-01-01T00:00',
        end_at: '2000-06-01T00:00',
        late_end_at: '2000-07-01T00:00',
        year: 2026,
        teams: [1],
      },
      cookie: chiefCookie,
    });
    const { id: pastId } = await pastRes.json();

    const fileContent = Buffer.from('too late');
    const res = await uploadFile(pastId, studentCookie, [
      { name: 'test.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 400);

    // Cleanup
    await client.delete(`/api/admin/sessions/${pastId}`, { cookie: chiefCookie });
  });
});

// -- File download --
describe('File download (student)', () => {
  before(() => {
    // Get the file ID from the latest submission
    const files = db.prepare('SELECT id FROM submission_file WHERE submission_id = ?').all(submissionId);
    assert.ok(files.length > 0, 'Should have at least one file');
    fileId = files[0].id;
  });

  it('GET /api/submissions/:subId/files/:fileId serves PDF inline', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/files/${fileId}`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('inline'), 'PDF should be inline');
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });

  it('GET /api/submissions/:subId/files/:fileId 403 for wrong team', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/files/${fileId}`, {
      headers: { 'Cookie': student2Cookie },
    });
    assert.equal(res.status, 403);
  });

  it('GET /api/submissions/:subId/files/:fileId 404 for non-existent submission', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/99999/files/${fileId}`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 404);
  });

  it('GET /api/submissions/:subId/files/:fileId 404 for non-existent file', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/files/99999`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 404);
  });
});

describe('Submission zip download (student)', () => {
  it('GET /api/submissions/:subId/zip serves a zip for own team', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/zip`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition.includes('attachment'), 'zip should be attachment');
    assert.ok(disposition.includes('.zip'), 'filename should end with .zip');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'zip body should not be empty');
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'body should be a zip archive');
  });

  it('GET /api/submissions/:subId/zip 403 for wrong team', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/zip`, {
      headers: { 'Cookie': student2Cookie },
    });
    assert.equal(res.status, 403);
  });

  it('GET /api/submissions/:subId/zip 404 for non-existent submission', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/99999/zip`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 404);
  });
});

describe('Zip entry name sanitization (zip-slip)', () => {
  it('sanitizes path separators in original filenames inside the zip', async () => {
    // 격리된 세션에서 경로 순회 문자가 든 파일명을 업로드
    const sessionRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'ZipSlip Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 10485760,
        year: 2026,
        teams: [1],
        allowed_extensions: 'pdf',
      },
      cookie: chiefCookie,
    });
    assert.equal(sessionRes.status, 201);
    const { id: slipSessionId } = await sessionRes.json();

    const up = await uploadFile(slipSessionId, studentCookie, [
      { name: '../../../evil.pdf', type: 'application/pdf', content: Buffer.from('malicious') },
    ]);
    assert.equal(up.status, 200);
    const sub = await up.json();

    // 1차 방어: busboy(preservePath:false)가 업로드 시점에 경로를 제거한다
    const fileRow = db.prepare('SELECT original_name FROM submission_file WHERE submission_id = ?').get(sub.id);
    assert.ok(!fileRow.original_name.includes('/') && !fileRow.original_name.includes('\\'),
      'stored original_name must not contain path separators');

    // 2차 방어(sanitize)를 실제로 exercise한다: busboy를 우회해 DB에 경로 구분자·금지
    // 문자가 든 이름을 직접 심는다 (손상/레거시 행 시나리오). 이렇게 해야 아카이브
    // 빌더의 sanitize()가 no-op이 아니라 진짜로 치환하는지 검증된다.
    db.prepare('UPDATE submission_file SET original_name = ? WHERE submission_id = ?')
      .run('../../../evil:*.pdf', sub.id);

    const res = await fetch(`${baseUrl}/api/submissions/${sub.id}/zip`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 200);
    // zip 로컬 파일 헤더에 엔트리명이 평문으로 들어가므로 바이트 검색으로 검증.
    // sanitize('../../../evil:*.pdf') === '.._.._.._evil__.pdf'
    const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
    assert.ok(!body.includes('../../../evil'), 'zip must not contain raw traversal entry name');
    assert.ok(body.includes('.._.._.._evil__.pdf'), 'zip must contain the sanitized entry name');
  });
});

describe('File download (admin)', () => {
  it('GET /api/admin/submissions/:subId/files/:fileId serves PDF inline', async () => {
    const res = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/${fileId}`, {
      headers: { 'Cookie': adminCookie },
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('inline'), 'PDF should be inline');
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });

  it('GET /api/admin/submissions/:subId/files/:fileId detects and persists CP949 Korean text', async () => {
    const sub = db.prepare('SELECT session_id, team_num FROM submission WHERE id = ?').get(submissionId);
    const storedName = `${crypto.randomUUID()}.txt`;
    const originalName = '한글-CP949.txt';
    const content = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in CP949
    const dir = path.join(uploadsDir, String(sub.session_id), String(sub.team_num), String(submissionId));
    const filePath = path.join(dir, storedName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
    const inserted = db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, ?, ?, ?, 'text/plain')
    `).run(submissionId, originalName, storedName, content.length);

    try {
      const res = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/${inserted.lastInsertRowid}`, {
        headers: { 'Cookie': adminCookie },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /inline/);
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=euc-kr');
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(new TextDecoder('euc-kr').decode(body), '한글');
      const stored = db.prepare('SELECT text_charset FROM submission_file WHERE id = ?').get(inserted.lastInsertRowid);
      assert.equal(stored.text_charset, 'euc-kr', 'legacy file detection should be persisted');

      const rangeRes = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/${inserted.lastInsertRowid}`, {
        headers: { 'Cookie': adminCookie, 'Range': 'bytes=0-0' },
      });
      assert.equal(rangeRes.status, 206);
      assert.equal(rangeRes.headers.get('content-type'), 'text/plain; charset=euc-kr');
    } finally {
      db.prepare('DELETE FROM submission_file WHERE id = ?').run(inserted.lastInsertRowid);
      fs.rmSync(filePath, { force: true });
    }
  });

  it('GET /api/admin/submissions/:subId/files/:fileId keeps UTF-8 engineering symbols as UTF-8', async () => {
    const sub = db.prepare('SELECT session_id, team_num FROM submission WHERE id = ?').get(submissionId);
    const storedName = `${crypto.randomUUID()}.txt`;
    const originalName = 'engineering-UTF8.txt';
    const text = '25°C, ±0.1 mm, © 2026, 10 µm, café, 10 Å, m², £100';
    const content = Buffer.from(text, 'utf8');
    const dir = path.join(uploadsDir, String(sub.session_id), String(sub.team_num), String(submissionId));
    const filePath = path.join(dir, storedName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
    const inserted = db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, ?, ?, ?, 'text/plain')
    `).run(submissionId, originalName, storedName, content.length);

    try {
      const res = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/${inserted.lastInsertRowid}`, {
        headers: { 'Cookie': adminCookie },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(await res.text(), text);
    } finally {
      db.prepare('DELETE FROM submission_file WHERE id = ?').run(inserted.lastInsertRowid);
      fs.rmSync(filePath, { force: true });
    }
  });

  it('GET /api/admin/submissions/:subId/files/:fileId forces attachment for non-previewable type', async () => {
    // Find a non-PDF file (the "replacement.pdf" submission also has older docx if any).
    // Upload a fresh non-inline file and check disposition.
    const fileContent = Buffer.from('docx test content');
    const upRes = await uploadFile(sessionId, studentCookie, [
      { name: 'sample.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: fileContent },
    ]);
    assert.equal(upRes.status, 200);
    const subData = await upRes.json();
    const newFile = db.prepare('SELECT id FROM submission_file WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(subData.id);

    const res = await fetch(`${baseUrl}/api/admin/submissions/${subData.id}/files/${newFile.id}`, {
      headers: { 'Cookie': adminCookie },
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition.includes('attachment'), 'docx should be attachment');
    submissionId = subData.id; // keep test chain consistent with latest sub
  });

  it('GET /api/admin/submissions/:subId/files/:fileId 404 for non-existent submission', async () => {
    const res = await fetch(`${baseUrl}/api/admin/submissions/99999/files/${fileId}`, {
      headers: { 'Cookie': adminCookie },
    });
    assert.equal(res.status, 404);
  });

  it('GET /api/admin/submissions/:subId/files/:fileId 404 for non-existent file', async () => {
    const res = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/99999`, {
      headers: { 'Cookie': adminCookie },
    });
    assert.equal(res.status, 404);
  });
});

// -- Download logging: one log per download, not per HTTP Range request --
// Browsers fetch inline files (PDF preview) via many partial Range requests;
// res.sendFile re-runs the handler each time, so logging must be gated to the
// initial request only. Uses an isolated session to avoid touching the shared
// submissionId/sessionId chain.
describe('Download logging (Range dedup)', () => {
  let rangeSubId, rangeFileId;

  before(async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Range Dedup Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
        allowed_extensions: '',
      },
    });
    const { id } = await sessionRes.json();
    const up = await uploadFile(id, studentCookie, [
      { name: 'ranged.pdf', type: 'application/pdf', content: Buffer.alloc(4096, 'a') },
    ]);
    assert.equal(up.status, 200);
    rangeSubId = (await up.json()).id;
    rangeFileId = db.prepare('SELECT id FROM submission_file WHERE submission_id = ? LIMIT 1').get(rangeSubId).id;
  });

  for (const variant of [
    { label: 'student', action: 'file.download', path: () => `/api/submissions/${rangeSubId}/files/${rangeFileId}`, cookie: () => studentCookie },
    { label: 'admin', action: 'file.admin_download', path: () => `/api/admin/submissions/${rangeSubId}/files/${rangeFileId}`, cookie: () => adminCookie },
  ]) {
    it(`${variant.label}: logs once per download, not on each Range request`, async () => {
      const countLogs = () => db.prepare(
        `SELECT COUNT(*) AS c FROM logs WHERE action = ? AND detail LIKE '%ranged.pdf%'`,
      ).get(variant.action).c;
      const before = countLogs();

      // Initial request (no Range header) logs once.
      const full = await fetch(`${baseUrl}${variant.path()}`, { headers: { Cookie: variant.cookie() } });
      assert.equal(full.status, 200);
      await full.arrayBuffer();
      assert.equal(countLogs(), before + 1, 'initial download should log once');

      // A Range continuation (start > 0) is served as 206 and must NOT log again.
      const partial = await fetch(`${baseUrl}${variant.path()}`, {
        headers: { Cookie: variant.cookie(), Range: 'bytes=10-20' },
      });
      assert.equal(partial.status, 206);
      await partial.arrayBuffer();
      assert.equal(countLogs(), before + 1, 'Range continuation must not log again');
    });
  }
});

// -- Session status after submission --
describe('Session status after submission', () => {
  it('GET /api/admin/sessions/:id/status shows submission and submissionCount', async () => {
    const res = await client.get(`/api/admin/sessions/${sessionId}/status`, { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.status[0].submission);
    assert.ok(data.status[0].submission.id);
    assert.ok(data.status[0].files.length > 0);
    assert.equal(typeof data.status[0].submissionCount, 'number');
    assert.ok(data.status[0].submissionCount >= 1, 'submissionCount should reflect total submissions');
  });
});

// -- Session detail after submission --
describe('Session detail after submission', () => {
  it('GET /api/sessions/:id shows submission for student', async () => {
    const res = await client.get(`/api/sessions/${sessionId}`, { cookie: studentCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.submission);
    assert.equal(data.submission.id, submissionId);
    assert.ok(data.files.length > 0);
  });
});

// -- Auth enforcement --
describe('Auth enforcement', () => {
  it('POST /api/admin/sessions without auth returns 401', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Unauth Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [1],
      },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/sessions without auth returns 401', async () => {
    const res = await client.get('/api/sessions');
    assert.equal(res.status, 401);
  });

  it('POST /api/admin/sessions with student cookie returns 403 (chief required)', async () => {
    const res = await client.post('/api/admin/sessions', {
      body: {
        name: 'Student Admin Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        year: 2026,
        teams: [1],
      },
      cookie: studentCookie,
    });
    assert.equal(res.status, 403);
  });

  it('GET /api/sessions with chief cookie returns 200 (chief > student)', async () => {
    const res = await client.get('/api/sessions', { cookie: chiefCookie });
    assert.equal(res.status, 200);
  });

  it('GET /api/admin/sessions with official cookie returns 403 (chief required)', async () => {
    const res = await client.get('/api/admin/sessions', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });

  it('GET /api/admin/student-teams without auth returns 401', async () => {
    const res = await client.get('/api/admin/student-teams');
    assert.equal(res.status, 401);
  });

  it('POST /api/admin/student-teams with student cookie returns 403', async () => {
    const res = await client.post('/api/admin/student-teams', {
      body: { email: 'x@test.com', team_num: 1, year: 2026 },
      cookie: studentCookie,
    });
    assert.equal(res.status, 403);
  });

  it('DELETE /api/admin/student-teams/:email/:year without auth returns 401', async () => {
    const res = await client.delete('/api/admin/student-teams/student1@test.com/2026');
    assert.equal(res.status, 401);
  });

  it('GET /api/admin/students without auth returns 401', async () => {
    const res = await client.get('/api/admin/students');
    assert.equal(res.status, 401);
  });

  it('GET /api/health without auth returns 200 (public)', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
  });
});

// -- File size limit enforcement --
describe('File size limit', () => {
  let smallSizeSessionId;

  it('rejects file exceeding max_file_size (413)', async () => {
    // Create session with very small max_file_size (100 bytes)
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Size Limit Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 100, // 100 bytes
        year: 2026,
        teams: [1],
        allowed_extensions: '',
      },
    });
    assert.equal(sessionRes.status, 201);
    const { id } = await sessionRes.json();
    smallSizeSessionId = id;

    // Upload a file larger than 100 bytes
    const largeContent = Buffer.alloc(200, 'x'); // 200 bytes > 100 limit
    const res = await uploadFile(smallSizeSessionId, studentCookie, [
      { name: 'big.pdf', type: 'application/pdf', content: largeContent },
    ]);
    assert.equal(res.status, 413);

    // rejection must be logged (CLAUDE.md logging policy)
    const log = db.prepare(
      "SELECT * FROM logs WHERE action = 'submission.create' AND level = 'warn' AND detail LIKE '%file_size_exceeded%' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(log, 'size rejection should be logged');
    assert.match(log.detail, /"max_file_size":100/);
  });
});

// -- Session update - team removal cleanup --
describe('Session update - team removal cleanup', () => {
  let cleanupSessionId;

  it('removes submissions when team is removed from session', async () => {
    // Create a new student mapping for team 3
    await client.post('/api/admin/student-teams', {
      cookie: chiefCookie,
      body: { email: 'student2@test.com', team_num: 3, year: 2026 },
    });

    // Create a session with teams [1, 3]
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Cleanup Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2026,
        teams: [1, 3],
        allowed_extensions: '',
      },
    });
    const { id } = await sessionRes.json();
    cleanupSessionId = id;

    // Submit a file as student2 (team 3)
    const res = await uploadFile(cleanupSessionId, student2Cookie, [
      { name: 'test.pdf', type: 'application/pdf', content: Buffer.from('test file for team 3') },
    ]);
    assert.equal(res.status, 200);

    // Verify team 3 has a submission
    const statusBefore = await client.get(`/api/admin/sessions/${cleanupSessionId}/status`, { cookie: chiefCookie });
    const beforeData = await statusBefore.json();
    const team3Before = beforeData.status.find(s => s.team_num === 3);
    assert.ok(team3Before?.submission, 'team 3 should have submission before removal');

    // Update session to remove team 3
    const updateRes = await client.put(`/api/admin/sessions/${cleanupSessionId}`, {
      cookie: chiefCookie,
      body: {
        name: 'Cleanup Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        teams: [1], // removed team 3
        allowed_extensions: '',
      },
    });
    assert.equal(updateRes.status, 200);

    // Verify team 3's submission is cleaned up
    const statusAfter = await client.get(`/api/admin/sessions/${cleanupSessionId}/status`, { cookie: chiefCookie });
    const afterData = await statusAfter.json();
    const team3After = afterData.status.find(s => s.team_num === 3);
    assert.equal(team3After, undefined, 'team 3 should not exist after removal');
  });
});

// -- Late submission --
describe('Late submission', () => {
  it('marks submission as late when submitted between end_at and late_end_at', async () => {
    // Create session: start in past, end in past (but before late_end), late_end in future
    // Use a clearly-past end_at to avoid string comparison edge cases between
    // the now() format ("YYYY-MM-DD HH:MM:SS") and stored format ("YYYY-MM-DDTHH:MM")
    const pastStart = '2020-01-01T00:00';
    const pastEnd = '2020-06-01T00:00';
    const futureLateEnd = '2030-12-31T23:59';

    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Late Submit Test',
        start_at: pastStart,
        end_at: pastEnd,
        late_end_at: futureLateEnd,
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
        allowed_extensions: '',
      },
    });
    assert.equal(sessionRes.status, 201);
    const { id: lateSessionId } = await sessionRes.json();

    // Submit file (should succeed but be marked late)
    const res = await uploadFile(lateSessionId, studentCookie, [
      { name: 'late.pdf', type: 'application/pdf', content: Buffer.from('late submission content') },
    ]);
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.is_late, 1, 'submission should be marked as late');
  });
});

// -- Multiple file upload --
describe('Multiple file upload', () => {
  it('uploads multiple files in single submission', async () => {
    // Create a new session for this test
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Multi File Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
        allowed_extensions: '',
      },
    });
    const { id: multiSessionId } = await sessionRes.json();

    const res = await uploadFile(multiSessionId, studentCookie, [
      { name: 'file1.pdf', type: 'application/pdf', content: Buffer.from('file 1 content') },
      { name: 'file2.pdf', type: 'application/pdf', content: Buffer.from('file 2 content') },
    ]);
    assert.equal(res.status, 200);

    // Verify session detail shows 2 files
    const detail = await client.get(`/api/sessions/${multiSessionId}`, { cookie: studentCookie });
    const data = await detail.json();
    assert.equal(data.files.length, 2, 'should have 2 files');
  });
});

// -- Internal API: PATCH /api/internal/team-num --
describe('PATCH /api/internal/team-num', () => {
  let internalSessionId;

  before(() => {
    // Create prerequisite data for internal API tests
    // Student-team mapping for team_num=50, year=2025
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('internal-test@test.com', 50, 2025);

    // Session for year 2025
    const sessionResult = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2025-01-01 00:00', '2025-12-31 23:59', '', 52428800, 'admin@test.com', 2025)",
    ).run('Internal Test Session');
    internalSessionId = sessionResult.lastInsertRowid;

    // session_team for team_num=50
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(internalSessionId, 50);

    // submission for team_num=50
    db.prepare(
      "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late) VALUES (?, 50, 'internal-test@test.com', '2025-06-01 11:59', '2025-06-01 12:00', 1024, 0)",
    ).run(internalSessionId);
  });

  it('updates student_team, session_team, and submission team_num', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 50, newNum: 99, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    // Verify student_team updated
    const studentTeam = db.prepare("SELECT team_num FROM student_team WHERE email = 'internal-test@test.com' AND year = 2025").get();
    assert.equal(studentTeam.team_num, 99);

    // Verify session_team updated
    const sessionTeam = db.prepare("SELECT team_num FROM session_team WHERE session_id = ? AND team_num = 99").get(internalSessionId);
    assert.ok(sessionTeam, 'session_team should have team_num=99');

    // Verify old team_num no longer exists in session_team
    const oldSessionTeam = db.prepare("SELECT team_num FROM session_team WHERE session_id = ? AND team_num = 50").get(internalSessionId);
    assert.equal(oldSessionTeam, undefined, 'old team_num=50 should not exist in session_team');

    // Verify submission updated
    const submission = db.prepare("SELECT team_num FROM submission WHERE session_id = ?").get(internalSessionId);
    assert.equal(submission.team_num, 99);
  });

  it('renames upload directory when it exists', async () => {
    // Rename back from 99 to 50 first for a clean state
    await client.patch('/api/internal/team-num', {
      body: { prevNum: 99, newNum: 50, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });

    // Create a fake upload dir for session/team
    const oldDir = path.join(uploadsDir, String(internalSessionId), '50');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'test.txt'), 'test');

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 50, newNum: 77, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    const newDir = path.join(uploadsDir, String(internalSessionId), '77');
    assert.ok(fs.existsSync(newDir), 'new upload dir should exist');
    assert.ok(!fs.existsSync(oldDir), 'old upload dir should not exist');
    assert.ok(fs.existsSync(path.join(newDir, 'test.txt')), 'files should be preserved');
  });

  it('returns 500 and rolls back DB when rename fails', async () => {
    // Setup: ensure team_num=77 from previous test
    const studentBefore = db.prepare("SELECT team_num FROM student_team WHERE email = 'internal-test@test.com' AND year = 2025").get();
    const currentNum = studentBefore.team_num;

    // Create upload dir for the current team
    const oldDir = path.join(uploadsDir, String(internalSessionId), String(currentNum));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'keep.txt'), 'data');

    // Create a non-empty directory at the target path to cause rename to fail
    const targetNum = 88;
    const blockingDir = path.join(uploadsDir, String(internalSessionId), String(targetNum));
    fs.mkdirSync(blockingDir, { recursive: true });
    fs.writeFileSync(path.join(blockingDir, 'blocker.txt'), 'block');

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: currentNum, newNum: targetNum, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 500, 'should return 500 when rename fails');

    // Verify DB was rolled back
    const studentAfter = db.prepare("SELECT team_num FROM student_team WHERE email = 'internal-test@test.com' AND year = 2025").get();
    assert.equal(studentAfter.team_num, currentNum, 'student_team should be rolled back');

    const sessionTeam = db.prepare("SELECT team_num FROM session_team WHERE session_id = ? AND team_num = ?").get(internalSessionId, currentNum);
    assert.ok(sessionTeam, 'session_team should be rolled back');

    // Verify original upload dir still exists
    assert.ok(fs.existsSync(oldDir), 'original upload dir should still exist');

    // Cleanup blocking dir
    fs.rmSync(blockingDir, { recursive: true, force: true });
  });

  it('returns 500 and rolls back successful renames across multiple sessions', async () => {
    const studentBefore = db.prepare("SELECT team_num FROM student_team WHERE email = 'internal-test@test.com' AND year = 2025").get();
    const currentNum = studentBefore.team_num;
    const targetNum = 95;

    // Create a second session for the same year
    const session2Result = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2025-01-01 00:00', '2025-12-31 23:59', '', 52428800, 'admin@test.com', 2025)",
    ).run('Internal Test Session 2');
    const session2Id = session2Result.lastInsertRowid;

    // Session 1: upload dir exists, no blocker → rename will succeed
    const s1OldDir = path.join(uploadsDir, String(internalSessionId), String(currentNum));
    fs.mkdirSync(s1OldDir, { recursive: true });
    fs.writeFileSync(path.join(s1OldDir, 'file1.txt'), 'data1');

    // Session 2: upload dir exists, blocker at target → rename will fail
    const s2OldDir = path.join(uploadsDir, String(session2Id), String(currentNum));
    const s2BlockDir = path.join(uploadsDir, String(session2Id), String(targetNum));
    fs.mkdirSync(s2OldDir, { recursive: true });
    fs.writeFileSync(path.join(s2OldDir, 'file2.txt'), 'data2');
    fs.mkdirSync(s2BlockDir, { recursive: true });
    fs.writeFileSync(path.join(s2BlockDir, 'blocker.txt'), 'block');

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: currentNum, newNum: targetNum, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 500, 'should return 500 when any rename fails');

    // Verify DB was rolled back
    const studentAfter = db.prepare("SELECT team_num FROM student_team WHERE email = 'internal-test@test.com' AND year = 2025").get();
    assert.equal(studentAfter.team_num, currentNum, 'student_team should be rolled back');

    // Verify session 1 successful rename was reverted
    assert.ok(fs.existsSync(s1OldDir), 'session 1 old dir should be restored');
    assert.ok(!fs.existsSync(path.join(uploadsDir, String(internalSessionId), String(targetNum))), 'session 1 target dir should not exist');

    // Verify session 2 old dir still exists
    assert.ok(fs.existsSync(s2OldDir), 'session 2 old dir should still exist');

    // Cleanup
    fs.rmSync(s2BlockDir, { recursive: true, force: true });
    fs.rmSync(s1OldDir, { recursive: true, force: true });
    fs.rmSync(s2OldDir, { recursive: true, force: true });
    db.prepare("DELETE FROM session WHERE id = ?").run(session2Id);
  });

  it('replaces stale target rows and upload directory on renumber collision', async () => {
    const year = 2031;
    const prevNum = 600;
    const newNum = 601;
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-prev@test.com', prevNum, year);
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-target@test.com', newNum, year);
    const sessionId = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2031-01-01 00:00', '2031-12-31 23:59', '', 52428800, 'admin@test.com', ?)",
    ).run('Renumber Collision Session', year).lastInsertRowid;
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, prevNum);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, newNum);
    db.prepare(
      "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late) VALUES (?, ?, ?, '2031-06-01 11:59', '2031-06-01 12:00', 1024, 0)",
    ).run(sessionId, prevNum, 'renumber-prev@test.com');
    db.prepare(
      "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late) VALUES (?, ?, ?, '2031-06-01 11:59', '2031-06-01 12:00', 2048, 0)",
    ).run(sessionId, newNum, 'renumber-target@test.com');

    const oldDir = path.join(uploadsDir, String(sessionId), String(prevNum));
    const newDir = path.join(uploadsDir, String(sessionId), String(newNum));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'prev.txt'), 'prev');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'stale.txt'), 'stale');

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum, newNum, year },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM student_team WHERE team_num = ? AND year = ?").get(newNum, year).c, 1);
    assert.equal(db.prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?").get('renumber-prev@test.com', year).team_num, newNum);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM session_team WHERE session_id = ? AND team_num = ?").get(sessionId, newNum).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM submission WHERE session_id = ? AND team_num = ?").get(sessionId, newNum).c, 1);
    assert.ok(!fs.existsSync(oldDir), 'old upload dir should be gone');
    assert.ok(fs.existsSync(path.join(newDir, 'prev.txt')), 'prev files should move to new dir');
    assert.ok(!fs.existsSync(path.join(newDir, 'stale.txt')), 'stale target files should be removed');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 0);
  });

  it('resumes pending upload directory work after the DB renumber has already committed', async () => {
    const year = 2032;
    const prevNum = 620;
    const newNum = 621;
    const sessionId = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2032-01-01 00:00', '2032-12-31 23:59', '', 52428800, 'admin@test.com', ?)",
    ).run('Renumber Retry Session', year).lastInsertRowid;
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-retry@test.com', newNum, year);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, newNum);
    db.prepare(
      "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late) VALUES (?, ?, ?, '2032-06-01 11:59', '2032-06-01 12:00', 1024, 0)",
    ).run(sessionId, newNum, 'renumber-retry@test.com');

    const oldDir = path.join(uploadsDir, String(sessionId), String(prevNum));
    const newDir = path.join(uploadsDir, String(sessionId), String(newNum));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'prev.txt'), 'prev');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'stale.txt'), 'stale');
    db.prepare(`
      INSERT INTO team_renumber_file_work (year, prev_num, new_num, session_id, move_old, delete_target)
      VALUES (?, ?, ?, ?, 1, 1)
    `).run(year, prevNum, newNum, sessionId);

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum, newNum, year },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(oldDir), 'old upload dir should be consumed by retry');
    assert.ok(fs.existsSync(path.join(newDir, 'prev.txt')), 'retry should preserve prev files under new number');
    assert.ok(!fs.existsSync(path.join(newDir, 'stale.txt')), 'retry should remove stale target files');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 0);
  });

  it('returns 202 and keeps retryable file work when disk rename fails after DB commit', async () => {
    const year = 2035;
    const prevNum = 650;
    const newNum = 651;
    const sessionId = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2035-01-01 00:00', '2035-12-31 23:59', '', 52428800, 'admin@test.com', ?)",
    ).run('Renumber Post Commit Retry Session', year).lastInsertRowid;
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-post-commit@test.com', prevNum, year);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, prevNum);
    db.prepare(
      "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late) VALUES (?, ?, ?, '2035-06-01 11:59', '2035-06-01 12:00', 1024, 0)",
    ).run(sessionId, prevNum, 'renumber-post-commit@test.com');

    const oldDir = path.join(uploadsDir, String(sessionId), String(prevNum));
    const newDir = path.join(uploadsDir, String(sessionId), String(newNum));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'prev.txt'), 'prev');

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (from === oldDir && to === newDir) throw new Error('simulated rename failure');
      return originalRenameSync.call(fs, from, to);
    };
    try {
      const res = await client.patch('/api/internal/team-num', {
        body: { prevNum, newNum, year },
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      });
      assert.equal(res.status, 202, 'post-commit file failure should be retryable, not reported as unchanged');
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(db.prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?").get('renumber-post-commit@test.com', year).team_num, newNum);
    assert.ok(fs.existsSync(oldDir), 'old dir remains for retry');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 1);

    const retry = await client.patch('/api/internal/team-num', {
      body: { prevNum, newNum, year },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(retry.status, 200);
    assert.ok(!fs.existsSync(oldDir), 'retry should consume old dir');
    assert.ok(fs.existsSync(path.join(newDir, 'prev.txt')), 'retry should move files');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 0);
  });

  it('finishes pending upload work when a prior attempt already moved the directory with a marker', async () => {
    const year = 2033;
    const prevNum = 630;
    const newNum = 631;
    const sessionId = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2033-01-01 00:00', '2033-12-31 23:59', '', 52428800, 'admin@test.com', ?)",
    ).run('Renumber Marker Retry Session', year).lastInsertRowid;
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-marker@test.com', newNum, year);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, newNum);
    db.prepare(`
      INSERT INTO team_renumber_file_work (year, prev_num, new_num, session_id, move_old, delete_target)
      VALUES (?, ?, ?, ?, 1, 1)
    `).run(year, prevNum, newNum, sessionId);

    const oldDir = path.join(uploadsDir, String(sessionId), String(prevNum));
    const newDir = path.join(uploadsDir, String(sessionId), String(newNum));
    const marker = path.join(newDir, `.fsk-renumber-${year}-${prevNum}-to-${newNum}.pending`);
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'prev.txt'), 'prev');
    fs.writeFileSync(marker, 'pending');

    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum, newNum, year },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(oldDir), 'old upload dir should remain absent');
    assert.ok(fs.existsSync(path.join(newDir, 'prev.txt')), 'already moved files should remain');
    assert.ok(!fs.existsSync(marker), 'completion marker should be removed');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 0);
  });

  it('does not keep retrying completed upload work when marker cleanup fails', async () => {
    const year = 2034;
    const prevNum = 640;
    const newNum = 641;
    const sessionId = db.prepare(
      "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year) VALUES (?, '', '2034-01-01 00:00', '2034-12-31 23:59', '', 52428800, 'admin@test.com', ?)",
    ).run('Renumber Marker Cleanup Session', year).lastInsertRowid;
    db.prepare("INSERT OR IGNORE INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run('renumber-marker-cleanup@test.com', newNum, year);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)").run(sessionId, newNum);
    db.prepare(`
      INSERT INTO team_renumber_file_work (year, prev_num, new_num, session_id, move_old, delete_target)
      VALUES (?, ?, ?, ?, 1, 1)
    `).run(year, prevNum, newNum, sessionId);

    const newDir = path.join(uploadsDir, String(sessionId), String(newNum));
    const marker = path.join(newDir, `.fsk-renumber-${year}-${prevNum}-to-${newNum}.pending`);
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'prev.txt'), 'prev');
    fs.writeFileSync(marker, 'pending');

    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (target === marker) throw new Error('simulated marker cleanup failure');
      return originalRmSync.call(fs, target, options);
    };
    try {
      const res = await client.patch('/api/internal/team-num', {
        body: { prevNum, newNum, year },
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      });
      assert.equal(res.status, 200);
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.ok(fs.existsSync(marker), 'marker may remain when best-effort cleanup fails');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM team_renumber_file_work WHERE year = ? AND prev_num = ? AND new_num = ?").get(year, prevNum, newNum).c, 0);
    fs.rmSync(marker, { force: true });
  });

  it('returns 400 for non-integer prevNum', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 'abc', newNum: 2, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns 400 for non-integer newNum', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 1, newNum: 2.5, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns 400 for non-integer year', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 1, newNum: 2, year: 'abc' },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns 400 for missing params', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: {},
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('requires admin auth (student gets 403)', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 1, newNum: 2, year: 2025 },
      cookie: studentCookie,
    });
    assert.equal(res.status, 403);
  });

  it('accessible via internal service header', async () => {
    // No matching data, but should still return 200 (just no-op)
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 9999, newNum: 9998, year: 2025 },
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
  });

  it('returns 401 without any auth', async () => {
    const res = await client.patch('/api/internal/team-num', {
      body: { prevNum: 1, newNum: 2, year: 2025 },
    });
    assert.equal(res.status, 401);
  });
});

// -- 2-set retention --
describe('2-set retention', () => {
  let retentionSessionId;
  let sub1Id, sub2Id, sub3Id;

  before(async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: '2-Set Retention Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2026,
        teams: [1],
        allowed_extensions: '',
      },
    });
    const { id } = await sessionRes.json();
    retentionSessionId = id;
  });

  it('1st submission creates a record', async () => {
    const res = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v1.pdf', type: 'application/pdf', content: Buffer.from('version 1') },
    ]);
    assert.equal(res.status, 200);
    sub1Id = (await res.json()).id;
  });

  it('2nd submission keeps both (2 total)', async () => {
    const res = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v2.pdf', type: 'application/pdf', content: Buffer.from('version 2') },
    ]);
    assert.equal(res.status, 200);
    sub2Id = (await res.json()).id;

    const all = db.prepare('SELECT id FROM submission WHERE session_id = ? AND team_num = 1 ORDER BY id DESC').all(retentionSessionId);
    assert.equal(all.length, 2, 'should have 2 submissions');
    assert.equal(all[0].id, sub2Id);
    assert.equal(all[1].id, sub1Id);
  });

  it('3rd submission deletes oldest, keeps 2', async () => {
    const res = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v3.pdf', type: 'application/pdf', content: Buffer.from('version 3') },
    ]);
    assert.equal(res.status, 200);
    sub3Id = (await res.json()).id;

    const all = db.prepare('SELECT id FROM submission WHERE session_id = ? AND team_num = 1 ORDER BY id DESC').all(retentionSessionId);
    assert.equal(all.length, 2, 'should have exactly 2 submissions');
    assert.equal(all[0].id, sub3Id, 'newest should be kept');
    assert.equal(all[1].id, sub2Id, 'second newest should be kept');

    // sub1 should be gone
    const deleted = db.prepare('SELECT * FROM submission WHERE id = ?').get(sub1Id);
    assert.equal(deleted, undefined, 'oldest submission should be deleted');

    // sub1 files should be gone
    const deletedFiles = db.prepare('SELECT * FROM submission_file WHERE submission_id = ?').all(sub1Id);
    assert.equal(deletedFiles.length, 0, 'oldest submission files should be deleted');

    // sub1 disk directory should be gone
    const sub1Dir = path.join(uploadsDir, String(retentionSessionId), '1', String(sub1Id));
    assert.ok(!fs.existsSync(sub1Dir), 'oldest submission disk files should be deleted');
  });

  it('sub2 disk files still exist', () => {
    const sub2Dir = path.join(uploadsDir, String(retentionSessionId), '1', String(sub2Id));
    assert.ok(fs.existsSync(sub2Dir), 'previous submission disk files should exist');
  });

  it('admin status returns prevSubmission and prevFiles', async () => {
    const res = await client.get(`/api/admin/sessions/${retentionSessionId}/status`, { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const team1 = data.status.find(s => s.team_num === 1);
    assert.ok(team1.submission, 'should have current submission');
    assert.equal(team1.submission.id, sub3Id, 'current submission should be the newest');
    assert.ok(team1.prevSubmission, 'should have previous submission');
    assert.equal(team1.prevSubmission.id, sub2Id, 'prevSubmission should be second newest');
    assert.ok(team1.files.length > 0, 'should have current files');
    assert.ok(team1.prevFiles.length > 0, 'should have previous files');
    // 3 submissions were inserted; oldest row was pruned, but submissionCount tracks total attempts via attempt_no.
    assert.equal(team1.submissionCount, 3, 'submissionCount should reflect total submission attempts');
    assert.equal(team1.submission.attempt_no, 3);
    assert.equal(team1.prevSubmission.attempt_no, 2);
  });

  it('student API still returns only latest submission', async () => {
    const res = await client.get(`/api/sessions/${retentionSessionId}`, { cookie: studentCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.submission.id, sub3Id, 'student should see only the latest');
    assert.ok(!data.prevSubmission, 'student API should not have prevSubmission');
  });

  it('4th submission keeps submissionCount increasing past retention cap', async () => {
    const res = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v4.pdf', type: 'application/pdf', content: Buffer.from('version 4') },
    ]);
    assert.equal(res.status, 200);

    const statusRes = await client.get(`/api/admin/sessions/${retentionSessionId}/status`, { cookie: chiefCookie });
    const data = await statusRes.json();
    const team1 = data.status.find(s => s.team_num === 1);
    assert.equal(team1.submissionCount, 4, 'submissionCount must keep growing even though only 2 rows remain');
    assert.equal(team1.submission.attempt_no, 4);
    assert.equal(team1.prevSubmission.attempt_no, 3);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM submission WHERE session_id = ? AND team_num = 1').get(retentionSessionId);
    assert.equal(rows.c, 2, 'DB row count is still capped at 2 by retention');
  });
});

// -- Year file purge --
describe('DELETE /api/admin/years/:year/files', () => {
  let purgeSessionId;

  before(async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Purge Test',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2025,
        teams: [1],
        allowed_extensions: '',
      },
    });
    const { id } = await sessionRes.json();
    purgeSessionId = id;

    // Need student-team for year 2025
    try {
      await client.post('/api/admin/student-teams', {
        cookie: chiefCookie,
        body: { email: 'student1@test.com', team_num: 1, year: 2025 },
      });
    } catch { /* may already exist */ }

    await uploadFile(purgeSessionId, studentCookie, [
      { name: 'purge-test.pdf', type: 'application/pdf', content: Buffer.from('purge test content') },
    ]);
  });

  it('returns 400 for invalid year', async () => {
    const res = await client.delete('/api/admin/years/abc/files', { cookie: chiefCookie });
    assert.equal(res.status, 400);
  });

  it('returns 404 for year with no sessions', async () => {
    const res = await client.delete('/api/admin/years/2001/files', { cookie: chiefCookie });
    assert.equal(res.status, 404);
  });

  it('requires chief+ auth', async () => {
    const res = await client.delete('/api/admin/years/2025/files', { cookie: studentCookie });
    assert.equal(res.status, 403);
  });

  it('deletes files but keeps submission records', async () => {
    // Verify files exist before purge
    const filesBefore = db.prepare(
      'SELECT sf.* FROM submission_file sf JOIN submission s ON s.id = sf.submission_id WHERE s.session_id = ?',
    ).all(purgeSessionId);
    assert.ok(filesBefore.length > 0, 'should have files before purge');

    const res = await client.delete('/api/admin/years/2025/files', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.sessions > 0);
    assert.ok(data.files > 0);

    // submission_file records should be gone
    const filesAfter = db.prepare(
      'SELECT sf.* FROM submission_file sf JOIN submission s ON s.id = sf.submission_id WHERE s.session_id = ?',
    ).all(purgeSessionId);
    assert.equal(filesAfter.length, 0, 'submission_file records should be deleted');

    // submission records should still exist
    const subs = db.prepare('SELECT * FROM submission WHERE session_id = ?').all(purgeSessionId);
    assert.ok(subs.length > 0, 'submission records should be preserved');

    // disk files should be gone
    const sessionDir = path.join(uploadsDir, String(purgeSessionId));
    assert.ok(!fs.existsSync(sessionDir), 'upload directory should be deleted');
  });

  it('is idempotent (re-purge succeeds)', async () => {
    const res = await client.delete('/api/admin/years/2025/files', { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.files, 0, 'no files to delete on re-purge');
  });
});

// -- Year archive download --
describe('GET /api/admin/years/:year/archive', () => {
  it('returns 400 for invalid year', async () => {
    const res = await fetch(`${baseUrl}/api/admin/years/abc/archive`, {
      headers: { 'Cookie': chiefCookie },
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for year with no sessions', async () => {
    const res = await fetch(`${baseUrl}/api/admin/years/2001/archive`, {
      headers: { 'Cookie': chiefCookie },
    });
    assert.equal(res.status, 404);
  });

  it('requires chief+ auth', async () => {
    const res = await fetch(`${baseUrl}/api/admin/years/2026/archive`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 403);
  });

  it('returns zip file for year with submissions', async () => {
    const res = await fetch(`${baseUrl}/api/admin/years/2026/archive`, {
      headers: { 'Cookie': chiefCookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition.includes('FSK_2026_documents.zip'), 'should have correct filename');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'zip should not be empty');
    // Verify zip magic bytes (PK\x03\x04)
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });

  it('returns 404 for purged year (no files)', async () => {
    // Year 2025 was purged in previous test section
    const res = await fetch(`${baseUrl}/api/admin/years/2025/archive`, {
      headers: { 'Cookie': chiefCookie },
    });
    assert.equal(res.status, 404);
  });
});

// ─── Internal API: team deletion ─────────────────────────────────────────
describe('DELETE /api/internal/team/:num', () => {
  let deleteTestSessionId;

  before(async () => {
    // Create student-team mapping for team 10
    await client.post('/api/admin/student-teams', {
      cookie: chiefCookie,
      body: { email: 'student1@test.com', team_num: 10, year: 2025 },
    });

    // Create a session with team 10
    const sessionRes = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Delete Test Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        late_end_at: '',
        max_file_size: 52428800,
        year: 2025,
        teams: [1, 10],
        allowed_extensions: '',
      },
    });
    const { id } = await sessionRes.json();
    deleteTestSessionId = id;
  });

  it('requires admin auth (internal service header)', async () => {
    const res = await client.delete('/api/internal/team/10?year=2025');
    assert.equal(res.status, 401);
  });

  it('returns 400 for invalid team number', async () => {
    const res = await client.delete('/api/internal/team/abc?year=2025', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns 400 for missing year', async () => {
    const res = await client.delete('/api/internal/team/10', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('cleans up student-team mapping, session-team, and submissions', async () => {
    const res = await client.delete('/api/internal/team/10?year=2025', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);

    // Verify student-team mapping is removed
    const teams = await client.get('/api/admin/student-teams?year=2025', { cookie: chiefCookie });
    const teamsData = await teams.json();
    assert.ok(!teamsData.some(t => t.team_num === 10), 'team 10 mapping should be removed');

    // Verify team is removed from session
    const status = await client.get(`/api/admin/sessions/${deleteTestSessionId}/status`, { cookie: chiefCookie });
    const statusData = await status.json();
    assert.ok(!statusData.status.some(s => s.team_num === 10), 'team 10 should be removed from session');
    assert.ok(statusData.status.some(s => s.team_num === 1), 'team 1 should remain in session');
  });
});
