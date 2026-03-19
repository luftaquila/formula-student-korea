import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../documents/node_modules/express/index.js');
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

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  dbPath = tmpDbPath();
  uploadsDir = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
  const result = createDocumentsApp({ dbPath, uploadsDir });
  db = result.db;
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

    const res = await client.delete(`/api/admin/sessions/${id}`, { cookie: chiefCookie });
    assert.equal(res.status, 200);

    // Verify it's gone
    const listRes = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    const data = await listRes.json();
    assert.ok(!data.find(s => s.id === id));
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

  it('POST /api/sessions/:id/submit 403 if not target team', async () => {
    const fileContent = Buffer.from('unauthorized content');
    const res = await uploadFile(sessionId, student2Cookie, [
      { name: 'test.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 403);
  });

  it('POST /api/sessions/:id/submit replaces previous submission', async () => {
    const oldSubId = submissionId;
    const fileContent = Buffer.from('replacement file content');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'replacement.pdf', type: 'application/pdf', content: fileContent },
    ]);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    assert.notEqual(data.id, oldSubId);
    submissionId = data.id;

    // Old submission should be deleted
    const oldSub = db.prepare('SELECT * FROM submission WHERE id = ?').get(oldSubId);
    assert.equal(oldSub, undefined);
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

  it('GET /api/submissions/:subId/files/:fileId downloads file', async () => {
    const res = await fetch(`${baseUrl}/api/submissions/${submissionId}/files/${fileId}`, {
      headers: { 'Cookie': studentCookie },
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('attachment'));
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

describe('File download (admin)', () => {
  it('GET /api/admin/submissions/:subId/files/:fileId downloads file', async () => {
    const res = await fetch(`${baseUrl}/api/admin/submissions/${submissionId}/files/${fileId}`, {
      headers: { 'Cookie': adminCookie },
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('attachment'));
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

// -- Session status after submission --
describe('Session status after submission', () => {
  it('GET /api/admin/sessions/:id/status shows submission', async () => {
    const res = await client.get(`/api/admin/sessions/${sessionId}/status`, { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.status[0].submission);
    assert.ok(data.status[0].submission.id);
    assert.ok(data.status[0].files.length > 0);
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
      "INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, total_size, is_late) VALUES (?, 50, 'internal-test@test.com', '2025-06-01 12:00', 1024, 0)",
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
