import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../documents/node_modules/express/index.js');
const Database = require('../../documents/node_modules/better-sqlite3');
const archiver = require('../../documents/node_modules/archiver/index.js');
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TEST_SECRET,
  TRUST_JWT,
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

let server, baseUrl, client, db, dbPath, uploadsDir, documentsApp;
let mockAuthServer;
let rejectedRemovalPath = null;
let injectedArchiveError = null;

function archiveFactory(...args) {
  if (!injectedArchiveError) return archiver(...args);
  const error = injectedArchiveError;
  injectedArchiveError = null;
  const handlers = new Map();
  return {
    on(event, handler) { handlers.set(event, handler); return this; },
    pipe() { return this; },
    file() { return this; },
    async finalize() {
      handlers.get('error')?.(error);
    },
  };
}

const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const studentCookie = makeAuthCookie({ email: 'student1@test.com', name: 'Student 1', role: 'student' });
const student2Cookie = makeAuthCookie({ email: 'student2@test.com', name: 'Student 2', role: 'student' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const teamsByYear = new Map([
  [2025, {
    1: { id: 1, num: 1, univ: '서울대', team: '팀A', type: 'EV', active: true },
    10: { id: 10, num: 10, univ: '고려대', team: '팀J', type: 'EV', active: true },
  }],
  [2026, {
    1: { id: 1, num: 1, univ: '서울대', team: '팀A', type: 'EV', active: true },
    3: { id: 3, num: 3, univ: '연세대', team: '팀C', type: 'EV', active: true },
  }],
  [2090, {
    991: { id: 991, num: 991, univ: 'Inactive Univ', team: 'Inactive Team', type: null, active: false },
    992: { id: 992, num: 992, univ: 'Other Inactive Univ', team: 'Other Inactive Team', type: null, active: false },
  }],
]);
const teamStore = {
  moduleEntries: (year) => teamsByYear.get(Number(year)) ?? {},
  getById: (id) => Object.values(teamsByYear.get(2026) ?? {})
    .find((team) => team.id === Number(id))
    ?? Object.values(teamsByYear.get(2025) ?? {}).find((team) => team.id === Number(id))
    ?? Object.values(teamsByYear.get(2090) ?? {}).find((team) => team.id === Number(id))
    ?? null,
  getByNumber: (year, number) => teamsByYear.get(Number(year))?.[Number(number)] ?? null,
};

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

describe('managed upload startup cleanup', () => {
  it('keeps database-referenced files and removes orphan and temporary files before serving', () => {
    const cleanupPath = tmpDbPath();
    const cleanupUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const first = createDocumentsApp({ dbPath: cleanupPath, uploadsDir: cleanupUploads });
    if (first._schedulerInterval) clearInterval(first._schedulerInterval);
    const sessionId = first.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year, created_at)
      VALUES ('cleanup', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 1000, '', 'test', 2026, '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid;
    first.db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, 1)").run(sessionId);
    const submissionId = first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, is_late, storage_dir, attempt_no)
      VALUES (?, 1, 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, ?, 1)
    `).run(sessionId, `${sessionId}/team-1/1`).lastInsertRowid;
    first.db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, 'kept.txt', 'kept.txt', 4, 'text/plain')
    `).run(submissionId);
    const referenced = path.join(cleanupUploads, String(sessionId), 'team-1', '1', 'kept.txt');
    const orphan = path.join(cleanupUploads, 'orphan.txt');
    const temporary = path.join(cleanupUploads, '_tmp', 'partial.upload');
    fs.mkdirSync(path.dirname(referenced), { recursive: true });
    fs.writeFileSync(referenced, 'kept');
    fs.writeFileSync(orphan, 'orphan');
    fs.writeFileSync(temporary, 'partial');
    first.db.close();

    const second = createDocumentsApp({ dbPath: cleanupPath, uploadsDir: cleanupUploads });
    if (second._schedulerInterval) clearInterval(second._schedulerInterval);
    assert.equal(fs.existsSync(referenced), true);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(temporary), false);
    second.db.close();
    cleanup(cleanupPath);
    fs.rmSync(cleanupUploads, { recursive: true, force: true });
  });

  it('fails startup when a database-referenced upload is missing', () => {
    const cleanupPath = tmpDbPath();
    const cleanupUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const first = createDocumentsApp({ dbPath: cleanupPath, uploadsDir: cleanupUploads });
    if (first._schedulerInterval) clearInterval(first._schedulerInterval);
    const sessionId = first.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year, created_at)
      VALUES ('missing', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 1000, '', 'test', 2026, '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid;
    const submissionId = first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, is_late, storage_dir, attempt_no)
      VALUES (?, 1, 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, ?, 1)
    `).run(sessionId, `${sessionId}/team-1/1`).lastInsertRowid;
    first.db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, 'missing.txt', 'missing.txt', 7, 'text/plain')
    `).run(submissionId);
    first.db.close();

    assert.throws(
      () => createDocumentsApp({ dbPath: cleanupPath, uploadsDir: cleanupUploads }),
      /managed upload cleanup failed/,
    );
    cleanup(cleanupPath);
    fs.rmSync(cleanupUploads, { recursive: true, force: true });
  });

  it('fails before cleanup when a submission storage directory normalizes to the upload root', () => {
    const cleanupPath = tmpDbPath();
    const cleanupUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const first = createDocumentsApp({
      dbPath: cleanupPath, uploadsDir: cleanupUploads, enableNotificationScheduler: false,
    });
    const sessionId = Number(first.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year, created_at)
      VALUES ('root path', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 1000, '', 'test', 2026, '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid);
    first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, storage_dir)
      VALUES (?, 1, 'test', '2026-01-01T00:00:00.000Z', '.')
    `).run(sessionId);
    first.db.close();
    const marker = path.join(cleanupUploads, 'must-remain.txt');
    fs.writeFileSync(marker, 'kept');
    const secondDb = new Database(cleanupPath);

    try {
      assert.throws(
        () => createDocumentsApp({
          db: secondDb, uploadsDir: cleanupUploads, enableNotificationScheduler: false,
        }),
        /managed upload cleanup failed: submission storage path escapes the uploads directory/,
      );
      assert.equal(fs.readFileSync(marker, 'utf8'), 'kept');
    } finally {
      secondDb.close();
      cleanup(cleanupPath);
      fs.rmSync(cleanupUploads, { recursive: true, force: true });
    }
  });

  it('fails before cleanup when a zero-file submission storage directory is only a vertical tab', () => {
    const cleanupPath = tmpDbPath();
    const cleanupUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const first = createDocumentsApp({
      dbPath: cleanupPath, uploadsDir: cleanupUploads, enableNotificationScheduler: false,
    });
    const sessionId = Number(first.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year, created_at)
      VALUES ('blank path', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 1000, '', 'test', 2026, '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid);
    first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, storage_dir)
      VALUES (?, 1, 'test', '2026-01-01T00:00:00.000Z', ?)
    `).run(sessionId, '\u000b');
    first.db.close();
    const marker = path.join(cleanupUploads, 'must-remain.txt');
    fs.writeFileSync(marker, 'kept');
    const secondDb = new Database(cleanupPath);

    try {
      assert.throws(
        () => createDocumentsApp({
          db: secondDb, uploadsDir: cleanupUploads, enableNotificationScheduler: false,
        }),
        /managed upload cleanup failed: submission .* has no canonical storage directory/,
      );
      assert.equal(fs.readFileSync(marker, 'utf8'), 'kept');
    } finally {
      secondDb.close();
      cleanup(cleanupPath);
      fs.rmSync(cleanupUploads, { recursive: true, force: true });
    }
  });

  it('fails before touching an uploads root that is a symbolic link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsk-upload-root-link-'));
    const outside = path.join(root, 'outside');
    const linkedUploads = path.join(root, 'uploads');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'must-remain.txt'), 'outside');
    fs.symlinkSync(outside, linkedUploads, 'dir');
    const linkedDb = new Database(':memory:');
    try {
      assert.throws(
        () => createDocumentsApp({ db: linkedDb, uploadsDir: linkedUploads, enableNotificationScheduler: false }),
        /managed upload cleanup failed: uploads directory path contains a symbolic link/,
      );
      assert.equal(fs.readFileSync(path.join(outside, 'must-remain.txt'), 'utf8'), 'outside');
      assert.equal(fs.existsSync(path.join(outside, '_tmp')), false);
    } finally {
      linkedDb.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before touching an uploads root beneath a symbolic-link ancestor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsk-upload-ancestor-link-'));
    const realParent = path.join(root, 'real-parent');
    const linkedParent = path.join(root, 'linked-parent');
    const realUploads = path.join(realParent, 'uploads');
    const linkedUploads = path.join(linkedParent, 'uploads');
    const marker = path.join(realUploads, 'must-remain.txt');
    fs.mkdirSync(realUploads, { recursive: true });
    fs.writeFileSync(marker, 'outside');
    fs.symlinkSync(realParent, linkedParent, 'dir');
    const linkedDb = new Database(':memory:');
    try {
      assert.throws(
        () => createDocumentsApp({ db: linkedDb, uploadsDir: linkedUploads, enableNotificationScheduler: false }),
        /managed upload cleanup failed: uploads directory path contains a symbolic link/,
      );
      assert.equal(fs.readFileSync(marker, 'utf8'), 'outside');
      assert.equal(fs.existsSync(path.join(realUploads, '_tmp')), false);
    } finally {
      linkedDb.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on an intermediate symbolic link in a referenced upload path', () => {
    const cleanupPath = tmpDbPath();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsk-upload-parent-link-'));
    const cleanupUploads = path.join(root, 'uploads');
    const outside = path.join(root, 'outside');
    const first = createDocumentsApp({
      dbPath: cleanupPath, uploadsDir: cleanupUploads, enableNotificationScheduler: false,
    });
    const sessionId = Number(first.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year, created_at)
      VALUES ('linked', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 1000, '', 'test', 2026, '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid);
    const storageDir = `${sessionId}/team-1/1`;
    const submissionId = Number(first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, storage_dir)
      VALUES (?, 1, 'test', '2026-01-01T00:00:00.000Z', ?)
    `).run(sessionId, storageDir).lastInsertRowid);
    first.db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size)
      VALUES (?, 'kept.txt', 'kept.txt', 4)
    `).run(submissionId);
    first.db.close();

    const outsideFile = path.join(outside, 'team-1', '1', 'kept.txt');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, 'kept');
    fs.symlinkSync(outside, path.join(cleanupUploads, String(sessionId)), 'dir');
    const secondDb = new Database(cleanupPath);
    try {
      assert.throws(
        () => createDocumentsApp({ db: secondDb, uploadsDir: cleanupUploads, enableNotificationScheduler: false }),
        /referenced upload path contains a symbolic link/,
      );
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'kept');
      assert.equal(fs.lstatSync(path.join(cleanupUploads, String(sessionId))).isSymbolicLink(), true);
    } finally {
      secondDb.close();
      cleanup(cleanupPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers after a process exits between the final file move and metadata commit', () => {
    const crashPath = tmpDbPath();
    const crashUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const helper = path.resolve('tests/documents/fixtures/crash-after-upload-move.mjs');
    const child = spawnSync(process.execPath, [helper, crashPath, crashUploads], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(child.status, 77, `${child.stdout}\n${child.stderr}`);

    const crashedDb = new Database(crashPath);
    assert.equal(crashedDb.prepare('SELECT COUNT(*) AS count FROM submission').get().count, 0);
    crashedDb.close();
    assert.equal(
      fs.existsSync(path.join(crashUploads, '1', 'team-1', '1')),
      true,
      'the crash fixture must leave the moved directory as an unreferenced orphan',
    );

    const restarted = createDocumentsApp({
      dbPath: crashPath,
      uploadsDir: crashUploads,
      enableNotificationScheduler: false,
      teamStore: {
        moduleEntries: () => ({ 1: { id: 1, num: 1, univ: 'Crash U', team: 'Crash T', active: true } }),
        getByNumber: () => ({ id: 1 }),
      },
    });
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS count FROM submission').get().count, 0);
    assert.equal(fs.existsSync(path.join(crashUploads, '1')), false);
    restarted.db.close();
    cleanup(crashPath);
    fs.rmSync(crashUploads, { recursive: true, force: true });
  });
});

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  dbPath = tmpDbPath();
  uploadsDir = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
  const result = createDocumentsApp({
    dbPath,
    uploadsDir,
    teamStore,
    archiveFactory,
    removeDirectory: (dir) => {
      if (dir === rejectedRemovalPath) throw new Error('injected retained-file removal failure');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  documentsApp = result;
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
  await documentsApp.drainNotificationTasks();
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
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'student_team.delete' AND level = 'warn' AND target = 'nobody@test.com'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(warning.detail), {
      error: 'mapping_not_found', reason: 'mapping_not_found', year: 2026,
    });
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

  it('audits update and delete attempts for a missing session', async () => {
    const missingId = 99991;
    const update = await client.put(`/api/admin/sessions/${missingId}`, {
      body: {
        name: 'Missing Session',
        start_at: '2020-01-01T00:00',
        end_at: '2030-12-31T23:59',
        teams: [1],
      },
      cookie: chiefCookie,
    });
    const deletion = await client.delete(`/api/admin/sessions/${missingId}`, { cookie: chiefCookie });
    assert.deepEqual([update.status, deletion.status], [404, 404]);
    const warnings = db.prepare(`
      SELECT action, detail FROM logs
      WHERE level = 'warn' AND target = ? AND action IN ('session.update', 'session.delete')
      ORDER BY id
    `).all(`session:${missingId}`);
    assert.deepEqual(warnings.map((row) => row.action), ['session.update', 'session.delete']);
    for (const row of warnings) {
      assert.deepEqual(JSON.parse(row.detail), {
        error: 'session_not_found',
        reason: 'session_not_found',
        phase: 'session_preflight',
        session_id: missingId,
      });
    }
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

    const cleanupPath = path.join(uploadsDir, String(id));
    rejectedRemovalPath = cleanupPath;
    let res;
    try {
      res = await client.delete(`/api/admin/sessions/${id}`, { cookie: chiefCookie });
      assert.equal(res.status, 200);
    } finally {
      rejectedRemovalPath = null;
    }

    // Verify it's gone
    const listRes = await client.get('/api/admin/sessions', { cookie: chiefCookie });
    const data = await listRes.json();
    assert.ok(!data.find(s => s.id === id));

    // Verify scheduled notifications cascaded
    const afterCount = db.prepare('SELECT count(*) as c FROM scheduled_notification WHERE session_id = ?').get(id).c;
    assert.equal(afterCount, 0, 'scheduled notifications should cascade on session delete');
    const info = db.prepare(`
      SELECT detail FROM logs WHERE action = 'session.delete' AND level = 'info' AND target = 'Disposable Session'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(info.detail).file_cleanup, [{
      directory: cleanupPath,
      removed: false,
      error: 'injected retained-file removal failure',
    }]);
    const warning = db.prepare(`
      SELECT detail FROM logs WHERE action = 'session.delete' AND level = 'warn' AND target = 'Disposable Session'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(JSON.parse(warning.detail).error, 'partial_file_cleanup');
    assert.equal(JSON.parse(warning.detail).failed_cleanup[0].directory, cleanupPath);
    fs.rmSync(cleanupPath, { recursive: true, force: true });
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
  it('audits submission to a missing session', async () => {
    const missingId = 99992;
    const res = await client.post(`/api/sessions/${missingId}/submit`, {
      body: {}, cookie: studentCookie,
    });
    assert.equal(res.status, 404);
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'submission.create' AND level = 'warn' AND target = ?
      ORDER BY id DESC LIMIT 1
    `).get(`session:${missingId}`);
    assert.deepEqual(JSON.parse(warning.detail), {
      error: 'session_not_found',
      reason: 'session_not_found',
      phase: 'submission_preflight',
      session_id: missingId,
    });
  });

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

  it('uses a stored stable team ID without an unnecessary canonical lookup', async () => {
    const columns = db.prepare('PRAGMA table_info(student_team)').all();
    if (!columns.some((column) => column.name === 'team_id')) {
      db.exec('ALTER TABLE student_team ADD COLUMN team_id INTEGER');
    }
    db.prepare('UPDATE student_team SET team_id = 1 WHERE email = ? AND year = 2026')
      .run('student1@test.com');
    const originalLookup = teamStore.getByNumber;
    teamStore.getByNumber = () => { throw new Error('canonical lookup must not run'); };
    try {
      const res = await uploadFile(sessionId, studentCookie, [
        { name: 'stable-id.pdf', type: 'application/pdf', content: Buffer.from('stable') },
      ]);
      assert.equal(res.status, 200, await res.text());
    } finally {
      teamStore.getByNumber = originalLookup;
    }
  });

  it('logs a controlled failure when the required canonical-team fallback throws', async () => {
    db.prepare('UPDATE student_team SET team_id = NULL WHERE email = ? AND year = 2026')
      .run('student1@test.com');
    const originalLookup = teamStore.getByNumber;
    teamStore.getByNumber = () => { throw new Error('injected canonical lookup failure'); };
    try {
      const res = await uploadFile(sessionId, studentCookie, [
        { name: 'lookup.pdf', type: 'application/pdf', content: Buffer.from('lookup') },
      ]);
      assert.equal(res.status, 500);
      assert.equal(await res.text(), '팀 기준 정보를 확인할 수 없습니다.');
      const log = db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'submission.create' AND level = 'warn'
          AND detail LIKE '%canonical_team_lookup%'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.ok(log);
      assert.deepEqual(
        JSON.parse(log.detail),
        {
          error: 'injected canonical lookup failure',
          phase: 'canonical_team_lookup',
          session_id: sessionId,
          year: 2026,
          team_num: 1,
        },
      );
    } finally {
      teamStore.getByNumber = originalLookup;
      db.prepare('UPDATE student_team SET team_id = 1 WHERE email = ? AND year = 2026')
        .run('student1@test.com');
    }
  });

  it('rejects malformed multipart before creating a temporary directory and audits it', async () => {
    const before = fs.readdirSync(path.join(uploadsDir, '_tmp')).sort();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': studentCookie },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), '올바른 multipart 업로드 요청이 아닙니다.');
    assert.deepEqual(fs.readdirSync(path.join(uploadsDir, '_tmp')).sort(), before);
    const log = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'submission.create' AND level = 'warn'
        AND detail LIKE '%multipart_init%'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.ok(log);
    assert.equal(JSON.parse(log.detail).phase, 'multipart_init');
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
    const stored = db.prepare("SELECT team_id, storage_dir FROM submission WHERE id = ?").get(submissionId);
    assert.equal(stored.team_id, 1);
    assert.match(stored.storage_dir, new RegExp(`^${sessionId}/team-${stored.team_id}/`));
  });

  it('batches MIME mismatch warnings into one submission log', async () => {
    const beforeId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM logs').get().id;
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'first.pdf', type: 'text/plain', content: Buffer.from('first') },
      { name: 'second.pdf', type: 'application/octet-stream', content: Buffer.from('second') },
    ]);
    assert.equal(res.status, 200, await res.clone().text());
    submissionId = (await res.json()).id;

    const rows = db.prepare(`
      SELECT actor_email, detail FROM logs
      WHERE id > ? AND action = 'submission.create' AND level = 'warn'
        AND detail LIKE '%mime_mismatch%'
      ORDER BY id
    `).all(beforeId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_email, 'student1@test.com');
    const detail = JSON.parse(rows[0].detail);
    assert.equal(detail.total, 2);
    assert.deepEqual(detail.files.map((file) => file.filename), ['first.pdf', 'second.pdf']);
  });

  it('POST /api/sessions/:id/submit rejects wrong extension', async () => {
    // Session has allowed_extensions: 'pdf,docx'
    const fileContent = Buffer.from('test exe content');
    const res = await uploadFile(sessionId, studentCookie, [
      { name: 'test.exe', type: 'application/octet-stream', content: fileContent },
    ]);
    assert.equal(res.status, 400);

    // rejection must be logged (CONTRIBUTING.md logging policy)
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

  it('preserves retained metadata and files when old-submission deletion fails', async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Retention Delete Failure',
        start_at: '2020-01-01T00:00', end_at: '2030-12-31T23:59', late_end_at: '',
        max_file_size: 10485760, year: 2026, teams: [1], allowed_extensions: 'pdf',
      },
      cookie: chiefCookie,
    });
    assert.equal(sessionRes.status, 201);
    const { id: retentionSessionId } = await sessionRes.json();
    try {
      for (const label of ['first', 'second']) {
        const uploaded = await uploadFile(retentionSessionId, studentCookie, [
          { name: `${label}.pdf`, type: 'application/pdf', content: Buffer.from(label) },
        ]);
        assert.equal(uploaded.status, 200);
      }
      const oldest = db.prepare(`
        SELECT s.id, s.storage_dir, f.stored_name
        FROM submission s JOIN submission_file f ON f.submission_id = s.id
        WHERE s.session_id = ? ORDER BY s.id LIMIT 1
      `).get(retentionSessionId);
      const oldestFile = path.join(uploadsDir, oldest.storage_dir, oldest.stored_name);
      assert.equal(fs.existsSync(oldestFile), true);
      db.exec(`CREATE TRIGGER reject_retention_delete
        BEFORE DELETE ON submission
        WHEN OLD.id = ${Number(oldest.id)}
        BEGIN SELECT RAISE(ABORT, 'injected retention delete failure'); END`);

      const third = await uploadFile(retentionSessionId, studentCookie, [
        { name: 'third.pdf', type: 'application/pdf', content: Buffer.from('third') },
      ]);
      assert.equal(third.status, 200, await third.text());
      assert.ok(db.prepare('SELECT id FROM submission WHERE id = ?').get(oldest.id));
      assert.equal(fs.existsSync(oldestFile), true);
      const log = db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'submission.retention_cleanup' AND level = 'warn'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.ok(log);
      assert.deepEqual(JSON.parse(log.detail), {
        error: 'injected retention delete failure',
        submission_id: oldest.id,
        storage_dir: oldest.storage_dir,
        file_preserved: true,
      });
    } finally {
      db.exec('DROP TRIGGER IF EXISTS reject_retention_delete');
      db.prepare('DELETE FROM session WHERE id = ?').run(retentionSessionId);
      fs.rmSync(path.join(uploadsDir, String(retentionSessionId)), { recursive: true, force: true });
    }
  });

  it('records retention file deletion as failed when the directory remains on disk', async () => {
    const sessionRes = await client.post('/api/admin/sessions', {
      body: {
        name: 'Retention File Failure',
        start_at: '2020-01-01T00:00', end_at: '2030-12-31T23:59', late_end_at: '',
        max_file_size: 10485760, year: 2026, teams: [1], allowed_extensions: 'pdf',
      },
      cookie: chiefCookie,
    });
    assert.equal(sessionRes.status, 201);
    const { id: retentionSessionId } = await sessionRes.json();
    try {
      for (const label of ['first', 'second']) {
        const uploaded = await uploadFile(retentionSessionId, studentCookie, [
          { name: `${label}.pdf`, type: 'application/pdf', content: Buffer.from(label) },
        ]);
        assert.equal(uploaded.status, 200);
      }
      const oldest = db.prepare(`
        SELECT id, storage_dir FROM submission
        WHERE session_id = ? ORDER BY id LIMIT 1
      `).get(retentionSessionId);
      rejectedRemovalPath = path.join(uploadsDir, oldest.storage_dir);

      const third = await uploadFile(retentionSessionId, studentCookie, [
        { name: 'third.pdf', type: 'application/pdf', content: Buffer.from('third') },
      ]);
      assert.equal(third.status, 200, await third.text());
      assert.equal(db.prepare('SELECT id FROM submission WHERE id = ?').get(oldest.id), undefined);
      assert.equal(fs.existsSync(rejectedRemovalPath), true);

      const warning = db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'submission.retention_cleanup' AND level = 'warn'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.deepEqual(JSON.parse(warning.detail), {
        submission_id: oldest.id,
        storage_dir: oldest.storage_dir,
        metadata_deleted: true,
        file_removed: false,
        error: 'injected retained-file removal failure',
      });
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM logs
        WHERE action = 'submission.retention_cleanup' AND level = 'info'
          AND detail LIKE ?
      `).get(`%\"submission_id\":${oldest.id}%`).count, 0);
    } finally {
      rejectedRemovalPath = null;
      db.prepare('DELETE FROM session WHERE id = ?').run(retentionSessionId);
      fs.rmSync(path.join(uploadsDir, String(retentionSessionId)), { recursive: true, force: true });
    }
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
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'submission.create' AND level = 'warn' AND target = 'Future Session'
      ORDER BY id DESC LIMIT 1
    `).get();
    const detail = JSON.parse(warning.detail);
    assert.equal(detail.error, 'submission_not_open');
    assert.equal(detail.phase, 'submission_window');
    assert.equal(detail.session_id, futureId);
    assert.equal(detail.team_num, 1);

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
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'submission.create' AND level = 'warn' AND target = 'Past Session'
      ORDER BY id DESC LIMIT 1
    `).get();
    const detail = JSON.parse(warning.detail);
    assert.equal(detail.error, 'submission_closed');
    assert.equal(detail.phase, 'submission_window');
    assert.equal(detail.session_id, pastId);
    assert.equal(detail.team_num, 1);

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

describe('Historical submission reads', () => {
  it('lists and authorizes files and zip using the requested session year mapping', async () => {
    db.prepare("INSERT INTO student_team (email, team_num, year) VALUES ('student1@test.com', 10, 2025)").run();
    const historicalSessionId = Number(db.prepare(`
      INSERT INTO session
        (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year)
      VALUES ('Historical', '', '2020-01-01', '2030-01-01', '', 1000, '', 'test', 2025)
    `).run().lastInsertRowid);
    db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, 10)").run(historicalSessionId);
    const historicalSubmissionId = Number(db.prepare(`
      INSERT INTO submission
        (session_id, team_num, submitted_by, submitted_at, storage_dir, attempt_no)
      VALUES (?, 10, 'student1@test.com', '2025-01-01', ?, 1)
    `).run(historicalSessionId, `${historicalSessionId}/team-10/historical`).lastInsertRowid);
    const historicalFileId = Number(db.prepare(`
      INSERT INTO submission_file
        (submission_id, original_name, stored_name, size, mime_type)
      VALUES (?, 'historical.pdf', 'historical.pdf', 10, 'application/pdf')
    `).run(historicalSubmissionId).lastInsertRowid);
    const historicalDir = path.join(uploadsDir, String(historicalSessionId), 'team-10', 'historical');
    fs.mkdirSync(historicalDir, { recursive: true });
    fs.writeFileSync(path.join(historicalDir, 'historical.pdf'), 'historical');

    try {
      const listResponse = await client.get('/api/sessions?year=2025', { cookie: studentCookie });
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json();
      assert.deepEqual(list.team, { team_num: 10, year: 2025 });
      assert.ok(list.sessions.some((session) => session.id === historicalSessionId));

      const fileResponse = await fetch(
        `${baseUrl}/api/submissions/${historicalSubmissionId}/files/${historicalFileId}`,
        { headers: { Cookie: studentCookie } },
      );
      assert.equal(fileResponse.status, 200);
      assert.equal(await fileResponse.text(), 'historical');

      const zipResponse = await fetch(`${baseUrl}/api/submissions/${historicalSubmissionId}/zip`, {
        headers: { Cookie: studentCookie },
      });
      assert.equal(zipResponse.status, 200);
      const zip = Buffer.from(await zipResponse.arrayBuffer());
      assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK');

      const audit = db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'file.zip' AND level = 'info' AND target = '#10'
        ORDER BY id DESC LIMIT 1
      `).get();
      const auditDetail = JSON.parse(audit.detail);
      assert.equal(auditDetail.year, 2025);
      assert.deepEqual(auditDetail.team, {
        id: 10,
        year: 2025,
        number: 10,
        university: '고려대',
        name: '팀J',
        active: true,
      });

      injectedArchiveError = new Error('simulated admin ZIP archive failure');
      const failedAdminZip = await client.get(
        `/api/admin/submissions/${historicalSubmissionId}/zip`,
        { cookie: chiefCookie },
      );
      assert.equal(failedAdminZip.status, 500);
      const failureAudit = db.prepare(`
        SELECT target, detail FROM logs
        WHERE action = 'file.admin_zip' AND level = 'warn'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(failureAudit.target, '#10');
      assert.deepEqual(JSON.parse(failureAudit.detail), {
        team: {
          id: 10,
          year: 2025,
          number: 10,
          university: '고려대',
          name: '팀J',
          active: true,
        },
        error: 'simulated admin ZIP archive failure',
        year: 2025,
        submission_id: historicalSubmissionId,
        team_num: 10,
      });
    } finally {
      injectedArchiveError = null;
      db.prepare("DELETE FROM session WHERE id = ?").run(historicalSessionId);
      db.prepare("DELETE FROM student_team WHERE email = 'student1@test.com' AND year = 2025").run();
      fs.rmSync(path.join(uploadsDir, String(historicalSessionId)), { recursive: true, force: true });
    }
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
    const sub = db.prepare('SELECT session_id, team_num, storage_dir FROM submission WHERE id = ?').get(submissionId);
    const storedName = `${crypto.randomUUID()}.txt`;
    const originalName = '한글-CP949.txt';
    const content = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in CP949
    const dir = path.join(uploadsDir, sub.storage_dir);
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
      assert.equal(stored.text_charset, 'euc-kr', 'detected charset should be persisted');

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

    // rejection must be logged (CONTRIBUTING.md logging policy)
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
    const audit = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'session.update' AND level = 'info' AND target = 'Cleanup Test'
      ORDER BY id DESC LIMIT 1
    `).get();
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.before_teams, [1, 3]);
    assert.deepEqual(detail.after_teams, [1]);
    assert.equal(detail.deleted_submissions.length, 1);
    assert.equal(detail.deleted_submissions[0].id, team3Before.submission.id);
    assert.equal(detail.deleted_submissions[0].team_num, 3);
    assert.equal(detail.file_cleanup.length, 1);
    assert.equal(detail.file_cleanup[0].submission_id, team3Before.submission.id);
    assert.equal(detail.file_cleanup[0].team_num, 3);
    assert.equal(detail.file_cleanup[0].removed, true);
    assert.equal(detail.file_cleanup[0].error, null);
  });
});

describe('Account-assignment notification auditing', () => {
  it('records missing INTERNAL_SECRET with recipient, year, and team context', async () => {
    const email = 'notify-secret@test.invalid';
    const teamNum = 10;
    db.prepare('INSERT OR IGNORE INTO session_team (session_id, team_num) VALUES (?, ?)').run(sessionId, teamNum);
    const previousSecret = process.env.INTERNAL_SECRET;
    delete process.env.INTERNAL_SECRET;
    try {
      const response = await client.post('/api/admin/student-teams', {
        body: { email, team_num: teamNum, year: 2026 },
        cookie: chiefCookie,
      });
      assert.equal(response.status, 201, await response.text());
      while (documentsApp.hasPendingNotificationTasks()) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.env.INTERNAL_SECRET = previousSecret;
    }
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'student_team.notify' AND level = 'warn' AND target = ?
      ORDER BY id DESC LIMIT 1
    `).get(email);
    assert.deepEqual(JSON.parse(warning.detail), {
      error: 'INTERNAL_SECRET not configured',
      reason: 'INTERNAL_SECRET not configured',
      phase: 'recipient_send',
      recipient: email,
      year: 2026,
      team_num: teamNum,
      session_count: 1,
    });
    db.prepare('DELETE FROM student_team WHERE email = ? AND year = ?').run(email, 2026);
    db.prepare('DELETE FROM session_team WHERE session_id = ? AND team_num = ?').run(sessionId, teamNum);
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

    const sub1Dir = path.join(uploadsDir, String(retentionSessionId), 'team-1', String(sub1Id));
    assert.ok(!fs.existsSync(sub1Dir), 'oldest submission disk files should be deleted');

    const sub2Dir = path.join(uploadsDir, String(retentionSessionId), 'team-1', String(sub2Id));
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
    const warning = db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'year.purge_files' AND level = 'warn' AND target = '2001'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(warning.detail), {
      error: 'year_has_no_sessions', reason: 'year_has_no_sessions', year: 2001,
    });
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
    const cleanupPath = path.join(uploadsDir, String(purgeSessionId));
    rejectedRemovalPath = cleanupPath;
    try {
      const res = await client.delete('/api/admin/years/2025/files', { cookie: chiefCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.files, 0, 'no files to delete on re-purge');
    } finally {
      rejectedRemovalPath = null;
    }
    const info = db.prepare(`
      SELECT detail FROM logs WHERE action = 'year.purge_files' AND level = 'info'
      ORDER BY id DESC LIMIT 1
    `).get();
    const infoDetail = JSON.parse(info.detail);
    assert.ok(infoDetail.file_cleanup.some((item) =>
      item.session_id === purgeSessionId
      && item.directory === cleanupPath
      && item.removed === false
      && item.error === 'injected retained-file removal failure'));
    const warning = db.prepare(`
      SELECT detail FROM logs WHERE action = 'year.purge_files' AND level = 'warn' AND target = '2025'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(JSON.parse(warning.detail).error, 'partial_file_cleanup');
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

describe('TeamStore read failure auditing', () => {
  it('logs a structured warning before propagating an admin entry-list failure', async () => {
    const original = teamStore.moduleEntries;
    teamStore.moduleEntries = () => { throw new Error('injected team-store read failure'); };
    try {
      const res = await client.get('/api/admin/entries?year=2026', { cookie: chiefCookie });
      assert.equal(res.status, 500);
    } finally {
      teamStore.moduleEntries = original;
    }
    const log = db.prepare(`
      SELECT level, detail FROM logs
      WHERE module = 'documents' AND action = 'entry.admin_list'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(log.level, 'warn');
    assert.deepEqual(JSON.parse(log.detail), {
      error: 'injected team-store read failure',
      year: 2026,
    });
  });
});

describe('Documents mutation database preflight auditing', () => {
  it('turns each throwing preflight into a persisted controlled failure', async () => {
    const isolatedPath = tmpDbPath();
    const isolatedUploads = path.join(os.tmpdir(), `fsk-test-uploads-${crypto.randomUUID()}`);
    const rawDb = new Database(isolatedPath);
    let failSql = null;
    const proxyDb = new Proxy(rawDb, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (failSql && sql.includes(failSql)) throw new Error(`injected documents ${failSql} failure`);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const created = createDocumentsApp({
      db: proxyDb,
      uploadsDir: isolatedUploads,
      enableNotificationScheduler: false,
      validateUser: TRUST_JWT,
      teamStore,
    });
    const started = await startServer(created.app);
    const isolated = createClient(started.baseUrl);
    try {
      failSql = 'SELECT * FROM session WHERE id = ?';
      const submission = await isolated.post('/api/sessions/1/submit', { body: {}, cookie: studentCookie });
      const update = await isolated.put('/api/admin/sessions/1', { body: {}, cookie: chiefCookie });
      const deletion = await isolated.delete('/api/admin/sessions/1', { cookie: chiefCookie });
      assert.deepEqual([submission.status, update.status, deletion.status], [500, 500, 500]);

      failSql = 'SELECT team_num FROM student_team WHERE email = ? AND year = ?';
      const mapping = await isolated.delete('/api/admin/student-teams/missing@test.invalid/2026', {
        cookie: chiefCookie,
      });
      assert.equal(mapping.status, 500);

      failSql = 'SELECT id FROM session WHERE year = ? ORDER BY id';
      const purge = await isolated.delete('/api/admin/years/2026/files', { cookie: chiefCookie });
      assert.equal(purge.status, 500);
      failSql = null;

      const warnings = rawDb.prepare(`
        SELECT action, detail FROM logs
        WHERE level = 'warn' AND action IN (
          'submission.create', 'session.update', 'session.delete',
          'student_team.delete', 'year.purge_files'
        ) ORDER BY id
      `).all();
      assert.deepEqual(warnings.map((row) => row.action), [
        'submission.create', 'session.update', 'session.delete',
        'student_team.delete', 'year.purge_files',
      ]);
      const details = warnings.map((row) => JSON.parse(row.detail));
      assert.deepEqual(details.map((detail) => detail.phase), [
        'submission_preflight', 'session_preflight', 'session_preflight',
        'mapping_preflight', 'year_purge_preflight',
      ]);
      assert.ok(details.every((detail) => detail.error.startsWith('injected documents ')));
    } finally {
      failSql = null;
      await stopServer(started.server);
      await created.drainNotificationTasks();
      rawDb.close();
      cleanup(isolatedPath);
      fs.rmSync(isolatedUploads, { recursive: true, force: true });
    }
  });
});

// ─── Internal API: team deletion ─────────────────────────────────────────
describe('Inactive entries remain fully available in Documents', () => {
  const year = 2090;
  const num = 991;

  it('lists, assigns, targets, and accepts submissions for an inactive entry', async () => {
    const unmappedEntriesRes = await client.get(`/api/entries?year=${year}`, { cookie: student2Cookie });
    assert.equal(unmappedEntriesRes.status, 200);
    assert.deepEqual(await unmappedEntriesRes.json(), {}, 'an unmapped student cannot enumerate inactive entries');

    assert.equal(
      (await client.get(`/api/admin/entries?year=${year}`, { cookie: student2Cookie })).status,
      403,
      'the full inactive list requires chief access',
    );

    const adminEntries = await (await client.get(`/api/admin/entries?year=${year}`, { cookie: chiefCookie })).json();
    assert.equal(adminEntries[num].active, false);
    assert.equal(adminEntries[num + 1].active, false);

    const mapping = await client.post('/api/admin/student-teams', {
      body: { email: 'student2@test.com', team_num: num, year }, cookie: chiefCookie,
    });
    assert.equal(mapping.status, 201, 'inactive entries can be assigned to student accounts');

    const entries = await (await client.get(`/api/entries?year=${year}`, { cookie: student2Cookie })).json();
    assert.equal(entries[num].active, false);
    assert.equal(entries[num + 1], undefined, 'a student sees only the mapped inactive entry');

    const session = await client.post('/api/admin/sessions', {
      cookie: chiefCookie,
      body: {
        name: 'Inactive Entry Submission',
        notice: '',
        start_at: '2020-01-01T00:00:00.000Z',
        end_at: '2099-01-01T00:00:00.000Z',
        late_end_at: '',
        max_file_size: 1000,
        allowed_extensions: '',
        year,
        teams: [num],
      },
    });
    assert.equal(session.status, 201, 'inactive entries can be selected as session targets');
    const sessionId = (await session.json()).id;

    const studentView = await (await client.get('/api/sessions', { cookie: student2Cookie })).json();
    assert.equal(studentView.team.team_num, num);
    assert.ok(studentView.sessions.some((item) => item.id === sessionId));

    const upload = await uploadFile(sessionId, student2Cookie, [
      { name: 'inactive.txt', type: 'text/plain', content: Buffer.from('allowed') },
    ]);
    assert.equal(upload.status, 200, 'inactive entries can submit documents');

    const status = await (await client.get(`/api/admin/sessions/${sessionId}/status`, { cookie: chiefCookie })).json();
    assert.equal(status.status[0].team_num, num);
    assert.ok(status.status[0].submission);
    assert.equal(status.status[0].files[0].original_name, 'inactive.txt');
  });
});
