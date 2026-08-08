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
  startFakeEntryServer,
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

describe('team_id rekey migration', () => {
  it('rebuilds legacy tables with team_id/dir_seg once and stays idempotent on restart', () => {
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
      CREATE TABLE session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, notice TEXT DEFAULT '',
        start_at TEXT NOT NULL, end_at TEXT NOT NULL, late_end_at TEXT NOT NULL,
        max_file_size INTEGER NOT NULL DEFAULT 52428800,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        year INTEGER NOT NULL
      );
      INSERT INTO session (id, name, start_at, end_at, late_end_at, created_by, year)
        VALUES (1, 'Legacy', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z', '', 'a@b.c', 2026);
      CREATE TABLE session_team (
        session_id INTEGER NOT NULL,
        team_num INTEGER NOT NULL,
        PRIMARY KEY (session_id, team_num),
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      );
      INSERT INTO session_team (session_id, team_num) VALUES (1, 7);
      CREATE TABLE submission (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        team_num INTEGER NOT NULL,
        submitted_by TEXT NOT NULL,
        started_at TEXT DEFAULT '',
        submitted_at TEXT NOT NULL,
        total_size INTEGER NOT NULL DEFAULT 0,
        is_late INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      );
      INSERT INTO submission (session_id, team_num, submitted_by, submitted_at)
        VALUES (1, 7, 'legacy@test.com', '2026-06-01T00:00:00.000Z');
    `);
    legacyDb.close();

    for (const boot of [1, 2]) {
      const result = createDocumentsApp({ dbPath: legacyPath, uploadsDir: legacyUploads, skipTeamStateSync: true });
      if (result._schedulerInterval) clearInterval(result._schedulerInterval);
    if (result._schedulerStartupTimer) clearTimeout(result._schedulerStartupTimer);
      const d = result.db;

      // 세 테이블 모두 team_id 병기, 데이터 보존, submission은 legacy 디렉토리 세그먼트 고정
      for (const table of ['student_team', 'session_team', 'submission']) {
        const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        assert.ok(cols.includes('team_id'), `${table} should have team_id (boot ${boot})`);
      }
      assert.deepEqual(d.prepare('SELECT email, team_id, team_num, year FROM student_team').all(), [
        { email: 'legacy@test.com', team_id: null, team_num: 7, year: 2026 },
      ]);
      assert.deepEqual(d.prepare('SELECT session_id, team_id, team_num FROM session_team').all(), [
        { session_id: 1, team_id: null, team_num: 7 },
      ]);
      assert.equal(d.prepare('SELECT dir_seg FROM submission').get().dir_seg, '7',
        'legacy submissions keep their numeric upload dir segment');

      // 불변식은 두 키 모두에 유지: (email, year), (year, team_num)
      assert.throws(() => d.prepare('INSERT INTO student_team (email, team_num, year) VALUES (?, ?, ?)')
        .run('legacy@test.com', 8, 2026), /UNIQUE/);
      assert.throws(() => d.prepare('INSERT INTO student_team (email, team_num, year) VALUES (?, ?, ?)')
        .run('other@test.com', 7, 2026), /UNIQUE/);

      // session 삭제 CASCADE가 재구축된 session_team에도 살아있어야 한다
      if (boot === 2) {
        d.prepare('DELETE FROM session WHERE id = 1').run();
        assert.equal(d.prepare('SELECT COUNT(*) AS c FROM session_team').get().c, 0, 'FK CASCADE preserved');
      }

      // entry-push 리넘버 파일 작업 큐는 폐기
      assert.equal(d.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'team_renumber_file_work'").get().c, 0);
      d.close();
    }
    cleanup(legacyPath);
    fs.rmSync(legacyUploads, { recursive: true, force: true });
  });
});

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  // 메인 스위트는 entry 없이 돈다 — 라벨은 빈 객체로 저하되고 흐름은 그대로여야 한다.
  // 즉시 연결 거부되는 주소로 고정해 컨테이너 DNS(:9200) 타임아웃 지연·종료 후 로그를 피한다.
  process.env.ENTRY_SERVER = 'http://127.0.0.1:1';

  dbPath = tmpDbPath();
  uploadsDir = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
  const result = createDocumentsApp({ dbPath, uploadsDir, skipTeamStateSync: true });
  db = result.db;
  if (result._schedulerInterval) clearInterval(result._schedulerInterval);
  if (result._schedulerStartupTimer) clearTimeout(result._schedulerStartupTimer);
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
  it('POST /api/sessions/:id/submit rejects multipart without files without persisting', async () => {
    const before = db.prepare(
      'SELECT COUNT(*) AS count FROM submission WHERE session_id = ? AND team_num = 1',
    ).get(sessionId).count;

    const res = await uploadFile(sessionId, studentCookie, []);

    assert.equal(res.status, 400);
    assert.equal(await res.text(), '파일을 선택하세요.');
    const after = db.prepare(
      'SELECT COUNT(*) AS count FROM submission WHERE session_id = ? AND team_num = 1',
    ).get(sessionId).count;
    assert.equal(after, before, 'an empty multipart request must not create a submission');
  });

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

  it('POST /api/sessions/:id/submit applies the BOM, UTF-8-first, and CP949 fallback policy', async () => {
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
      const utf8Text = '¯ 25°C, ±0.1 mm, 10 µm, café';
      const cases = [
        {
          name: 'utf8-valid-first',
          charset: 'utf-8',
          content: Buffer.from(utf8Text, 'utf8'),
        },
        { name: 'cp949-invalid-utf8', charset: 'euc-kr', content: Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]) },
        { name: 'utf8-bom', charset: 'utf-8', content: Buffer.from([0xef, 0xbb, 0xbf, 0x41]) },
        { name: 'utf16le-bom', charset: 'utf-16le', content: Buffer.from([0xff, 0xfe, 0x41, 0x00]) },
        { name: 'utf16be-bom', charset: 'utf-16be', content: Buffer.from([0xfe, 0xff, 0x00, 0x41]) },
      ];

      const res = await uploadFile(textSessionId, studentCookie, cases.map((encodingCase) => ({
        name: `${encodingCase.name}.txt`,
        type: 'text/plain',
        content: encodingCase.content,
      })));
      assert.equal(res.status, 200);
      const data = await res.json();
      const files = db.prepare(
        'SELECT id, original_name, text_charset FROM submission_file WHERE submission_id = ?',
      ).all(data.id);
      assert.deepEqual(
        Object.fromEntries(files.map((file) => [file.original_name, file.text_charset])),
        Object.fromEntries(cases.map((encodingCase) => [`${encodingCase.name}.txt`, encodingCase.charset])),
      );

      const utf8Case = cases[0];
      const utf8File = files.find((file) => file.original_name === `${utf8Case.name}.txt`);
      const previewRes = await fetch(`${baseUrl}/api/admin/submissions/${data.id}/files/${utf8File.id}`, {
        headers: { 'Cookie': adminCookie },
      });
      assert.equal(previewRes.status, 200);
      assert.equal(previewRes.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(await previewRes.text(), utf8Text);
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
    const sub = db.prepare('SELECT session_id, dir_seg FROM submission WHERE id = ?').get(submissionId);
    const storedName = `${crypto.randomUUID()}.txt`;
    const originalName = '한글-CP949.txt';
    const content = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in CP949
    const dir = path.join(uploadsDir, String(sub.session_id), sub.dir_seg, String(submissionId));
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

// -- 2-set retention --
describe('2-set retention', () => {
  let retentionSessionId;

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

  it('keeps the latest two sets while preserving the total attempt count', async () => {
    const first = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v1.pdf', type: 'application/pdf', content: Buffer.from('version 1') },
    ]);
    assert.equal(first.status, 200);
    const sub1Id = (await first.json()).id;

    const second = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v2.pdf', type: 'application/pdf', content: Buffer.from('version 2') },
    ]);
    assert.equal(second.status, 200);
    const sub2Id = (await second.json()).id;

    let retained = db.prepare('SELECT id FROM submission WHERE session_id = ? AND team_num = 1 ORDER BY id DESC').all(retentionSessionId);
    assert.deepEqual(retained.map(({ id }) => id), [sub2Id, sub1Id]);

    const third = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v3.pdf', type: 'application/pdf', content: Buffer.from('version 3') },
    ]);
    assert.equal(third.status, 200);
    const sub3Id = (await third.json()).id;

    retained = db.prepare('SELECT id FROM submission WHERE session_id = ? AND team_num = 1 ORDER BY id DESC').all(retentionSessionId);
    assert.deepEqual(retained.map(({ id }) => id), [sub3Id, sub2Id]);

    const deleted = db.prepare('SELECT * FROM submission WHERE id = ?').get(sub1Id);
    assert.equal(deleted, undefined, 'oldest submission should be deleted');

    const deletedFiles = db.prepare('SELECT * FROM submission_file WHERE submission_id = ?').all(sub1Id);
    assert.equal(deletedFiles.length, 0, 'oldest submission files should be deleted');

    const sub1Dir = path.join(uploadsDir, String(retentionSessionId), '1', String(sub1Id));
    assert.ok(!fs.existsSync(sub1Dir), 'oldest submission disk files should be deleted');

    const sub2Dir = path.join(uploadsDir, String(retentionSessionId), '1', String(sub2Id));
    assert.ok(fs.existsSync(sub2Dir), 'previous submission disk files should exist');

    const adminStatus = await client.get(`/api/admin/sessions/${retentionSessionId}/status`, { cookie: chiefCookie });
    assert.equal(adminStatus.status, 200);
    const adminData = await adminStatus.json();
    let team1 = adminData.status.find(s => s.team_num === 1);
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

    const studentStatus = await client.get(`/api/sessions/${retentionSessionId}`, { cookie: studentCookie });
    assert.equal(studentStatus.status, 200);
    const studentData = await studentStatus.json();
    assert.equal(studentData.submission.id, sub3Id, 'student should see only the latest');
    assert.ok(!studentData.prevSubmission, 'student API should not have prevSubmission');

    const fourth = await uploadFile(retentionSessionId, studentCookie, [
      { name: 'v4.pdf', type: 'application/pdf', content: Buffer.from('version 4') },
    ]);
    assert.equal(fourth.status, 200);

    const statusRes = await client.get(`/api/admin/sessions/${retentionSessionId}/status`, { cookie: chiefCookie });
    assert.equal(statusRes.status, 200);
    const finalData = await statusRes.json();
    team1 = finalData.status.find(s => s.team_num === 1);
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


// ─── Team-state 수렴형 강제 (구 내부 라이프사이클 라우트 대체) ─────────────
// entry가 team-num/team-delete 이벤트를 push하는 대신, documents가 team-state 스냅샷을
// pull해서 version 변경 시 tombstone cascade·비정규화 갱신을 멱등하게 적용한다.
// 디스크 업로드 디렉토리는 절대 옮기지 않는다 — 각 제출의 불변 dir_seg가 경로의 진실이다.
describe('Team-state convergent enforcement', () => {
  const YEAR = 2040;
  let fake, srv2, baseUrl2, cli2, db2, dp2, uploads2, teamState, sessId;
  let legacySubId, legacyFileId, inactiveSubId, renumberedSubId;
  let version = 0;

  // 스냅샷 상태는 스위트 전역에서 누적 변이 — 각 테스트가 entry의 다음 상태를 만든다.
  const teams = {
    501: { num: 51, univ: 'A대', team: '팀A', type: 'IC', active: true },
    502: { num: 52, univ: 'B대', team: '팀B', type: 'EV', active: false },
  };
  const tombstones = [];

  function publish() {
    version++;
    fake.setSnapshot(YEAR, { version, teams: structuredClone(teams), tombstones: structuredClone(tombstones) });
    return teamState.refresh(YEAR);
  }

  async function uploadTo(sessionId, cookie, files) {
    const boundary = '----FormBoundary' + crypto.randomUUID();
    const body = makeMultipartBody(boundary, files);
    return fetch(`${baseUrl2}/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Cookie': cookie },
      body,
    });
  }

  function seedSubmission({ teamId = null, teamNum, dirSeg, content }) {
    const subId = db2.prepare(`
      INSERT INTO submission (session_id, team_id, team_num, dir_seg, submitted_by, started_at, submitted_at, total_size, is_late, attempt_no)
      VALUES (?, ?, ?, ?, 'seed@test.com', '2040-06-01T11:59:00.000Z', '2040-06-01T12:00:00.000Z', ?, 0, 1)
    `).run(sessId, teamId, teamNum, dirSeg, content.length).lastInsertRowid;
    const storedName = `${crypto.randomUUID()}.pdf`;
    const fileId = db2.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, 'seeded.pdf', ?, ?, 'application/pdf')
    `).run(subId, storedName, content.length).lastInsertRowid;
    const dir = path.join(uploads2, String(sessId), dirSeg, String(subId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, storedName), content);
    return { subId, fileId, dir };
  }

  before(async () => {
    fake = await startFakeEntryServer();
    process.env.ENTRY_SERVER = fake.url;

    dp2 = tmpDbPath();
    uploads2 = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const result = createDocumentsApp({ dbPath: dp2, uploadsDir: uploads2, skipTeamStateSync: true });
    db2 = result.db;
    teamState = result.teamState;
    if (result._schedulerInterval) clearInterval(result._schedulerInterval);
    if (result._schedulerStartupTimer) clearTimeout(result._schedulerStartupTimer);

    // 첫 스냅샷 이전의 레거시 상태를 심는다 (전부 team_id NULL, 숫자 dir_seg) — 백필 검증용.
    sessId = db2.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, created_by, year)
      VALUES ('Enforcement Session', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 52428800, 'chief@test.com', ?)
    `).run(YEAR).lastInsertRowid;
    db2.prepare("INSERT INTO student_team (email, team_num, year) VALUES ('student1@test.com', 51, ?)").run(YEAR);
    db2.prepare("INSERT INTO student_team (email, team_num, year) VALUES ('student2@test.com', 52, ?)").run(YEAR);
    db2.prepare("INSERT INTO student_team (email, team_num, year) VALUES ('unknown@test.com', 99, ?)").run(YEAR);
    for (const num of [51, 52, 99]) {
      db2.prepare('INSERT INTO session_team (session_id, team_num) VALUES (?, ?)').run(sessId, num);
    }
    const legacy = seedSubmission({ teamNum: 51, dirSeg: '51', content: Buffer.from('legacy content') });
    legacySubId = legacy.subId;
    legacyFileId = legacy.fileId;
    seedSubmission({ teamNum: 99, dirSeg: '99', content: Buffer.from('unknown content') });

    const started = await startServer(result.app);
    srv2 = started.server;
    baseUrl2 = started.baseUrl;
    cli2 = createClient(baseUrl2);

    await publish(); // version 1 → 백필 + 강제
  });

  after(async () => {
    await stopServer(srv2);
    await fake.close();
    db2.close();
    cleanup(dp2);
    fs.rmSync(uploads2, { recursive: true, force: true });
    delete process.env.ENTRY_SERVER;
  });

  it('backfills team_id from the first snapshot and leaves unknown teams NULL (never deleted)', () => {
    assert.equal(db2.prepare("SELECT team_id FROM student_team WHERE email = 'student1@test.com' AND year = ?").get(YEAR).team_id, 501);
    assert.equal(db2.prepare("SELECT team_id FROM student_team WHERE email = 'student2@test.com' AND year = ?").get(YEAR).team_id, 502);
    assert.equal(db2.prepare('SELECT team_id FROM session_team WHERE session_id = ? AND team_num = 51').get(sessId).team_id, 501);
    assert.equal(db2.prepare('SELECT team_id FROM submission WHERE id = ?').get(legacySubId).team_id, 501);

    // entry가 모르는 팀 99는 NULL 그대로, 행도 보존
    assert.equal(db2.prepare("SELECT team_id FROM student_team WHERE email = 'unknown@test.com'").get().team_id, null);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_num = 99').get().c, 1);
    const log = db2.prepare("SELECT 1 FROM logs WHERE action = 'documents.team_id_backfill' AND level = 'warn'").get();
    assert.ok(log, 'unmatched legacy rows must be logged');
  });

  it('serves entry labels from the team-state cache, inactive teams included', async () => {
    const adminEntries = await (await cli2.get(`/api/admin/entries?year=${YEAR}`, { cookie: chiefCookie })).json();
    assert.equal(adminEntries[51].univ, 'A대');
    assert.equal(adminEntries[52].active, false, 'inactive teams stay listed (includeInactive parity)');

    const studentEntries = await (await cli2.get(`/api/entries?year=${YEAR}`, { cookie: student2Cookie })).json();
    assert.equal(studentEntries[52].active, false, 'a student sees the mapped team even when inactive');
    assert.equal(studentEntries[51], undefined, 'a student sees only the mapped team');
  });

  it('inactive teams can still submit; new submissions land in the immutable t<id> directory', async () => {
    const res = await uploadTo(sessId, student2Cookie, [
      { name: 'inactive.pdf', type: 'application/pdf', content: Buffer.from('inactive team upload') },
    ]);
    assert.equal(res.status, 200, 'documents ignores the active flag');
    inactiveSubId = (await res.json()).id;

    const row = db2.prepare('SELECT team_id, team_num, dir_seg FROM submission WHERE id = ?').get(inactiveSubId);
    assert.deepEqual(row, { team_id: 502, team_num: 52, dir_seg: 't502' });
    assert.ok(fs.existsSync(path.join(uploads2, String(sessId), 't502', String(inactiveSubId))));
  });

  it('renumber converges on all tables while the legacy upload dir keeps serving downloads', async () => {
    teams[501].num = 61;
    await publish();

    assert.equal(db2.prepare("SELECT team_num FROM student_team WHERE email = 'student1@test.com' AND year = ?").get(YEAR).team_num, 61);
    assert.equal(db2.prepare('SELECT team_num FROM session_team WHERE session_id = ? AND team_id = 501').get(sessId).team_num, 61);
    const sub = db2.prepare('SELECT team_num, dir_seg FROM submission WHERE id = ?').get(legacySubId);
    assert.equal(sub.team_num, 61, 'denormalized num follows the immutable id');
    assert.equal(sub.dir_seg, '51', 'dir_seg NEVER changes — the disk directory is not moved');

    // 핵심 회귀 테스트: 리넘버 후에도 저장된 dir_seg로 기존 파일이 그대로 내려간다
    const studentDl = await cli2.get(`/api/submissions/${legacySubId}/files/${legacyFileId}`, { cookie: studentCookie });
    assert.equal(studentDl.status, 200, 'student download must survive a renumber');
    assert.equal(await studentDl.text(), 'legacy content');

    const adminDl = await cli2.get(`/api/admin/submissions/${legacySubId}/files/${legacyFileId}`, { cookie: adminCookie });
    assert.equal(adminDl.status, 200, 'admin download must survive a renumber');
    assert.equal(await adminDl.text(), 'legacy content');
  });

  it('a new submission after the renumber uses the t<id> directory and downloads back', async () => {
    const res = await uploadTo(sessId, studentCookie, [
      { name: 'after-renumber.pdf', type: 'application/pdf', content: Buffer.from('post renumber') },
    ]);
    assert.equal(res.status, 200);
    renumberedSubId = (await res.json()).id;

    const row = db2.prepare('SELECT team_id, team_num, dir_seg FROM submission WHERE id = ?').get(renumberedSubId);
    assert.deepEqual(row, { team_id: 501, team_num: 61, dir_seg: 't501' });
    assert.ok(fs.existsSync(path.join(uploads2, String(sessId), 't501', String(renumberedSubId))));

    const fileId = db2.prepare('SELECT id FROM submission_file WHERE submission_id = ?').get(renumberedSubId).id;
    const dl = await cli2.get(`/api/submissions/${renumberedSubId}/files/${fileId}`, { cookie: studentCookie });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'post renumber');
  });

  it('adopts NULL-team_id rows on every version change and stores team_id on new mappings', async () => {
    teams[503] = { num: 53, univ: 'C대', team: '팀C', type: 'EV', active: true };
    await publish();

    // 캐시가 로드된 상태의 신규 매핑은 즉시 team_id를 저장한다
    const mapping = await cli2.post('/api/admin/student-teams', {
      body: { email: 'adopted@test.com', team_num: 53, year: YEAR }, cookie: chiefCookie,
    });
    assert.equal(mapping.status, 201);
    assert.equal(db2.prepare("SELECT team_id FROM student_team WHERE email = 'adopted@test.com'").get().team_id, 503);

    // 콜드 캐시 기간에 NULL로 생성된 행(시뮬레이션)은 다음 version 강제가 num 매칭으로 귀속
    db2.prepare("UPDATE student_team SET team_id = NULL WHERE email = 'adopted@test.com'").run();
    db2.prepare('INSERT INTO session_team (session_id, team_num) VALUES (?, 53)').run(sessId);
    const coldSub = seedSubmission({ teamNum: 53, dirSeg: '53', content: Buffer.from('cold cache') });
    await publish();

    assert.equal(db2.prepare("SELECT team_id FROM student_team WHERE email = 'adopted@test.com'").get().team_id, 503);
    assert.equal(db2.prepare('SELECT team_id FROM session_team WHERE session_id = ? AND team_num = 53').get(sessId).team_id, 503);
    assert.equal(db2.prepare('SELECT team_id FROM submission WHERE id = ?').get(coldSub.subId).team_id, 503);
  });

  it('tombstones cascade-delete rows and remove the upload directories', async () => {
    const inactiveDir = path.join(uploads2, String(sessId), 't502', String(inactiveSubId));
    assert.ok(fs.existsSync(inactiveDir), 'precondition: dir exists before the tombstone');

    delete teams[502];
    tombstones.push({ id: 502, num: 52, deleted_at: '2040-07-01T00:00:00.000Z' });
    await publish();

    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM student_team WHERE year = ? AND team_id = 502').get(YEAR).c, 0);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM session_team WHERE session_id = ? AND team_id = 502').get(sessId).c, 0);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_id = 502').get().c, 0);
    assert.ok(!fs.existsSync(inactiveDir), 'upload dir removed after the commit');
    assert.ok(db2.prepare("SELECT 1 FROM logs WHERE action = 'team.delete' AND level = 'info'").get(),
      'destructive cascade must be logged');

    // 멱등: 같은 tombstone 재적용에도 안전
    await publish();
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_id = 502').get().c, 0);
  });

  it('evicts stale rows occupying a num the snapshot assigns to another team', async () => {
    // entry가 모르는 팀(998)의 행이 num 62를 점유한 상태에서 팀 501이 62로 리넘버되면,
    // 구 PATCH team-num의 "target 행 삭제" 시맨틱대로 stale 행과 디렉토리를 치우고 수렴한다.
    db2.prepare('INSERT INTO session_team (session_id, team_id, team_num) VALUES (?, 998, 62)').run(sessId);
    const stale = seedSubmission({ teamId: 998, teamNum: 62, dirSeg: '62', content: Buffer.from('stale') });

    teams[501].num = 62;
    await publish();

    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM session_team WHERE session_id = ? AND team_id = 998').get(sessId).c, 0);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_id = 998').get().c, 0);
    assert.ok(!fs.existsSync(stale.dir), 'stale target upload dir removed');
    assert.equal(db2.prepare('SELECT team_num FROM session_team WHERE session_id = ? AND team_id = 501').get(sessId).team_num, 62);
    assert.equal(db2.prepare('SELECT team_num FROM submission WHERE id = ?').get(legacySubId).team_num, 62);
  });

  it('unknown teams on unclaimed nums are preserved and only logged', async () => {
    const orphan = seedSubmission({ teamId: 999, teamNum: 98, dirSeg: '98', content: Buffer.from('orphan') });
    await publish();

    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_id = 999').get().c, 1, 'unknown-id rows are never deleted');
    assert.ok(fs.existsSync(orphan.dir), 'their upload dirs stay untouched');
    assert.ok(db2.prepare("SELECT 1 FROM logs WHERE action = 'documents.team_state_unknown' AND level = 'warn'").get());

    // 첫 스냅샷 이전부터 있던 NULL id 행(99)도 여전히 보존
    assert.equal(db2.prepare("SELECT COUNT(*) AS c FROM student_team WHERE email = 'unknown@test.com'").get().c, 1);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM submission WHERE team_num = 99').get().c, 1);
  });
});
