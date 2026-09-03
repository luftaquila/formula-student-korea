import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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

setupTestEnv();
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

import { createAuthApp } from '../../auth/index.mjs';

const require = createRequire(import.meta.url);
const Database = require('../../auth/node_modules/better-sqlite3');
const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createAuthApp({ dbPath });
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

// ─── Health ──────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });

});

// ─── User CRUD ───────────────────────────────────────────────────────────
describe('GET /api/users', () => {
  it('returns array with bootstrapped admin', async () => {
    const res = await client.get('/api/users', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const users = await res.json();
    assert.ok(Array.isArray(users));
    const admin = users.find(u => u.email === 'admin@test.com');
    assert.ok(admin, 'bootstrapped admin should exist');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.protected, true);
  });

  it('requires admin auth (401 without cookie)', async () => {
    const res = await client.get('/api/users');
    assert.equal(res.status, 401);
  });

  it('rejects non-admin roles (403)', async () => {
    // Register official user so auth validates it
    db.prepare("INSERT OR IGNORE INTO users (email, role, active) VALUES ('official@test.com', 'official', 1)").run();
    const res = await client.get('/api/users', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/users', () => {
  it('rejects the retired master role', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'master@test.com', role: 'master' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects the retired staff role', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'staff@test.com', role: 'staff' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('creates a user with valid email and role', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'new@example.com', role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.email, 'new@example.com');
    assert.equal(data.role, 'student');
    assert.ok(data.id);
  });

  it('rejects missing email (400)', async () => {
    const res = await client.post('/api/users', {
      body: { role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty email (400)', async () => {
    const res = await client.post('/api/users', {
      body: { email: '  ', role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid email format (400)', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'not-an-email', role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid role (400)', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'valid@example.com', role: 'superuser' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects duplicate email (400)', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'new@example.com', role: 'official' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('trims and lowercases email', async () => {
    const res = await client.post('/api/users', {
      body: { email: '  Trimmed@Example.COM  ', role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.email, 'trimmed@example.com');
  });

  it('requires admin auth (401 without cookie)', async () => {
    const res = await client.post('/api/users', {
      body: { email: 'noauth@example.com', role: 'student' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/users/bulk', () => {
  it('adds multiple users and skips duplicates', async () => {
    const res = await client.post('/api/users/bulk', {
      body: {
        users: [
          { email: 'bulk1@example.com', role: 'student' },
          { email: 'bulk2@example.com', role: 'official', realname: 'test realname' },
          { email: 'new@example.com', role: 'student' }, // duplicate from earlier
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 2);
    assert.equal(data.skipped, 1);
  });

  it('rejects empty users array (400)', async () => {
    const res = await client.post('/api/users/bulk', {
      body: { users: [] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-array users (400)', async () => {
    const res = await client.post('/api/users/bulk', {
      body: { users: 'not-array' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('reports errors for rows without email', async () => {
    const res = await client.post('/api/users/bulk', {
      body: {
        users: [
          { role: 'student' }, // no email
          { email: 'bulk3@example.com', role: 'student' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 1);
    assert.ok(data.errors.length > 0, 'should have errors for missing email');
  });

  it('defaults to student role for invalid role and reports error', async () => {
    const res = await client.post('/api/users/bulk', {
      body: {
        users: [
          { email: 'bulk4@example.com', role: 'superuser' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 1);
    assert.ok(data.errors.length > 0, 'should report invalid role error');

    // Verify it was actually created as student
    const user = db.prepare("SELECT role FROM users WHERE email = 'bulk4@example.com'").get();
    assert.equal(user.role, 'student');
  });

  // 행별 거절 사유는 예전엔 응답으로만 반환되고 버려졌다 — 감사 로그에도 남아야 한다.
  it('logs user.bulk_create at info level with per-row reject reasons', async () => {
    const res = await client.post('/api/users/bulk', {
      body: {
        users: [
          { email: 'bulklog1@example.com', role: 'student' },
          { role: 'student' },                                  // missing email
          { email: 'not-an-email', role: 'student' },           // bad format
          { email: 'bulklog2@example.com', role: 'superuser' }, // unknown role → student
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const row = db.prepare(
      "SELECT level, detail FROM logs WHERE action = 'user.bulk_create' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(row, 'the bulk create must be logged');
    assert.equal(row.level, 'info');
    const detail = JSON.parse(row.detail);
    assert.ok(Array.isArray(detail.errors), 'detail carries the reject reasons');
    assert.equal(detail.errors.length, 3);
    assert.ok(detail.errors.some((e) => e.reason.includes('이메일 없음')));
    assert.ok(detail.errors.some((e) => e.reason.includes('올바르지 않은 이메일 형식')));
    assert.ok(detail.errors.some((e) => e.email === 'bulklog2@example.com' && e.reason.includes('알 수 없는 역할')));
    assert.ok(detail.added.includes('bulklog1@example.com'));
  });
});

describe('PATCH /api/users/:id', () => {
  let testUserId;

  before(() => {
    const user = db.prepare("SELECT id FROM users WHERE email = 'new@example.com'").get();
    testUserId = user.id;
  });

  it('changes role', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { role: 'official' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.role, 'official');
  });

  it('changes realname', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { realname: 'updated realname' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT realname FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.realname, 'updated realname');
  });

  it('changes phone', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { phone: '010-1234-5678' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.phone, '010-1234-5678');
  });

  it('changes active status', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { active: false },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT active FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.active, 0);

    // Restore active
    await client.patch(`/api/users/${testUserId}`, {
      body: { active: true },
      cookie: adminCookie,
    });
  });

  it('handles complex update (role + realname)', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { role: 'student', realname: 'reassigned' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT role, realname FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.role, 'student');
    assert.equal(user.realname, 'reassigned');
  });

  it('rejects invalid role (400)', async () => {
    const res = await client.patch(`/api/users/${testUserId}`, {
      body: { role: 'superuser' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('protects ADMIN_EMAIL role change', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.patch(`/api/users/${admin.id}`, {
      body: { role: 'official' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('protects last admin demotion', async () => {
    // admin@test.com is the only admin; demoting it should fail
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.patch(`/api/users/${admin.id}`, {
      body: { role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('protects ADMIN_EMAIL deactivation', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.patch(`/api/users/${admin.id}`, {
      body: { active: false },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await client.patch('/api/users/99999', {
      body: { realname: 'nope' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/users/:id', () => {
  it('deletes a user', async () => {
    // Create a disposable user
    const createRes = await client.post('/api/users', {
      body: { email: 'disposable@example.com', role: 'student' },
      cookie: adminCookie,
    });
    const { id } = await createRes.json();

    const res = await client.delete(`/api/users/${id}`, { cookie: adminCookie });
    assert.equal(res.status, 200);

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    assert.equal(user, undefined);
  });

  it('protects ADMIN_EMAIL from deletion', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.delete(`/api/users/${admin.id}`, { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('protects last admin from deletion', async () => {
    // admin@test.com is the only admin
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.delete(`/api/users/${admin.id}`, { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await client.delete('/api/users/99999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('PATCH /api/users/bulk', () => {
  let bulkIds;

  before(() => {
    const users = db.prepare("SELECT id FROM users WHERE email IN ('bulk1@example.com', 'bulk2@example.com')").all();
    bulkIds = users.map(u => u.id);
  });

  it('bulk deactivates users', async () => {
    const res = await client.patch('/api/users/bulk', {
      body: { ids: bulkIds, active: false },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.updated, bulkIds.length);

    // Verify
    for (const id of bulkIds) {
      const user = db.prepare('SELECT active FROM users WHERE id = ?').get(id);
      assert.equal(user.active, 0);
    }
  });

  it('bulk activates users', async () => {
    const res = await client.patch('/api/users/bulk', {
      body: { ids: bulkIds, active: true },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.updated, bulkIds.length);
  });

  it('protects ADMIN_EMAIL from bulk deactivation', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.patch('/api/users/bulk', {
      body: { ids: [admin.id], active: false },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty ids (400)', async () => {
    const res = await client.patch('/api/users/bulk', {
      body: { ids: [], active: true },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing active value (400)', async () => {
    const res = await client.patch('/api/users/bulk', {
      body: { ids: bulkIds },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid ids (400)', async () => {
    const res = await client.patch('/api/users/bulk', {
      body: { ids: [1, 'abc'], active: true },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('DELETE /api/users/bulk', () => {
  it('bulk deletes users', async () => {
    // Create disposable users
    const ids = [];
    for (const email of ['bulkdel1@example.com', 'bulkdel2@example.com']) {
      const res = await client.post('/api/users', {
        body: { email, role: 'student' },
        cookie: adminCookie,
      });
      const data = await res.json();
      ids.push(data.id);
    }

    const res = await client.delete('/api/users/bulk', {
      body: { ids },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deleted, 2);
  });

  it('protects ADMIN_EMAIL from bulk deletion', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.delete('/api/users/bulk', {
      body: { ids: [admin.id] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('protects last admin from bulk deletion', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const res = await client.delete('/api/users/bulk', {
      body: { ids: [admin.id] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty ids (400)', async () => {
    const res = await client.delete('/api/users/bulk', {
      body: { ids: [] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid ids (400)', async () => {
    const res = await client.delete('/api/users/bulk', {
      body: { ids: ['abc'] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Internal Endpoints ──────────────────────────────────────────────────
describe('GET /api/users/exists/:email', () => {
  it('returns 200 for existing active user', async () => {
    const res = await client.get('/api/users/exists/admin@test.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await client.get('/api/users/exists/nonexistent@example.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 404);
  });

  it('returns 404 for inactive user', async () => {
    // Create and deactivate a user
    db.prepare("INSERT OR IGNORE INTO users (email, role, active) VALUES ('inactive@test.com', 'student', 0)").run();
    const res = await client.get('/api/users/exists/inactive@test.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 404);
  });

  it('requires admin auth (401 without credentials)', async () => {
    const res = await client.get('/api/users/exists/admin@test.com');
    assert.equal(res.status, 401);
  });
});

describe('GET /api/users/role/:email', () => {
  it('returns role for existing active user', async () => {
    const res = await client.get('/api/users/role/admin@test.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.role, 'admin');
  });

  it('returns 404 for non-existent user', async () => {
    const res = await client.get('/api/users/role/nonexistent@example.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 404);
  });

  it('returns 404 for inactive user', async () => {
    const res = await client.get('/api/users/role/inactive@test.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 404);
  });

  it('rejects an admin cookie because the endpoint is internal-only', async () => {
    const res = await client.get('/api/users/role/admin@test.com', {
      cookie: adminCookie,
    });
    assert.equal(res.status, 403);
  });
});

describe('Role schema migration', () => {
  it('maps retired roles to grant-free officials and flattens preview bundles', () => {
    const legacyPath = tmpDbPath();
    let legacyDb;
    let migratedDb;

    try {
      legacyDb = new Database(legacyPath);
      legacyDb.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          name TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin', 'master', 'chief', 'official', 'staff', 'student')),
          memo TEXT DEFAULT '',
          realname TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          affiliation TEXT DEFAULT '',
          created_at TEXT,
          active INTEGER DEFAULT 1
        );
        INSERT INTO users (email, name, role, affiliation) VALUES
          ('preserved@test.com', 'Preserved', 'official', '기존 소속'),
          ('legacy-staff@test.com', 'Legacy Staff', 'staff', ''),
          ('legacy-chief@test.com', 'Legacy Chief', 'chief', ''),
          ('legacy-master@test.com', 'Legacy Master', 'master', '');
        CREATE TABLE user_permission_bundle (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          bundle_key TEXT NOT NULL,
          PRIMARY KEY (user_id, bundle_key)
        );
        CREATE TABLE user_permission (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          permission_key TEXT NOT NULL,
          PRIMARY KEY (user_id, permission_key)
        );
        INSERT INTO user_permission_bundle
          SELECT id, 'documents_manager' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission_bundle
          SELECT id, 'queue_manager' FROM users WHERE email = 'legacy-staff@test.com';
        INSERT INTO user_permission
          SELECT id, 'course.operate' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'score.operate' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'applications.manage' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'contacts.manage' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'entry.manage' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'messaging.operate' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'audit.view' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission_bundle
          SELECT id, 'auditor' FROM users WHERE email = 'preserved@test.com';
        INSERT INTO user_permission
          SELECT id, 'queue.manage' FROM users WHERE email = 'legacy-chief@test.com';
        CREATE TABLE ops_display (
          user_id INTEGER PRIMARY KEY REFERENCES users(id),
          description TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO ops_display (user_id, description, sort_order)
          SELECT id, '기존 연락처', 3 FROM users WHERE email = 'preserved@test.com';
      `);
      legacyDb.close();
      legacyDb = null;

      migratedDb = createAuthApp({ dbPath: legacyPath }).db;
      assert.deepEqual(
        migratedDb.prepare("SELECT email, name, role, affiliation FROM users WHERE email = 'preserved@test.com'").get(),
        { email: 'preserved@test.com', name: 'Preserved', role: 'official', affiliation: '기존 소속' },
      );
      assert.deepEqual(
        migratedDb.prepare('SELECT user_id, description, sort_order FROM ops_display').get(),
        { user_id: 1, description: '기존 연락처', sort_order: 0 },
      );
      assert.deepEqual(migratedDb.pragma('foreign_key_check'), []);
      assert.deepEqual(
        migratedDb.prepare("SELECT email, role FROM users WHERE email LIKE 'legacy-%' ORDER BY email").all(),
        [
          { email: 'legacy-chief@test.com', role: 'official' },
          { email: 'legacy-master@test.com', role: 'official' },
          { email: 'legacy-staff@test.com', role: 'official' },
        ],
      );
      assert.equal(migratedDb.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user_permission_bundle'",
      ).get().count, 0);
      assert.deepEqual(
        migratedDb.prepare(`
          SELECT permission_key FROM user_permission
          WHERE user_id = (SELECT id FROM users WHERE email = 'preserved@test.com')
          ORDER BY permission_key
        `).all(),
        [
          { permission_key: 'course.manage' },
          { permission_key: 'documents.manage' },
          { permission_key: 'files.access' },
          { permission_key: 'score.manage' },
        ],
      );
      assert.equal(migratedDb.prepare(`
        SELECT COUNT(*) AS count FROM user_permission
        WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'legacy-%')
      `).get().count, 0);
      assert.throws(
        () => migratedDb.prepare("INSERT INTO users (email, role) VALUES ('retired@test.com', 'master')").run(),
        /CHECK constraint failed/,
      );
    } finally {
      legacyDb?.close();
      migratedDb?.close();
      cleanup(legacyPath);
    }
  });
});

describe('Ops contacts description migration', () => {
  it('adds the description column to an existing ops_display table without losing rows', () => {
    const legacyPath = tmpDbPath();
    let legacyDb;
    let migratedDb;

    try {
      legacyDb = createAuthApp({ dbPath: legacyPath }).db;
      const userId = legacyDb.prepare("INSERT INTO users (email, role, active) VALUES ('legacy-official@test.com', 'official', 1)").run().lastInsertRowid;
      legacyDb.prepare("INSERT INTO ops_display (user_id) VALUES (?)").run(userId);
      legacyDb.exec("ALTER TABLE ops_display DROP COLUMN description");
      legacyDb.close();
      legacyDb = null;

      migratedDb = createAuthApp({ dbPath: legacyPath }).db;
      const columns = migratedDb.prepare("PRAGMA table_info(ops_display)").all().map((column) => column.name);
      assert.ok(columns.includes('description'));
      assert.deepEqual(
        migratedDb.prepare("SELECT user_id, description FROM ops_display WHERE user_id = ?").get(userId),
        { user_id: userId, description: '' },
      );
    } finally {
      legacyDb?.close();
      migratedDb?.close();
      cleanup(legacyPath);
    }
  });
});

describe('Ops contacts ordering migration', () => {
  it('adds sort_order and preserves the previous user ID order', () => {
    const legacyPath = tmpDbPath();
    let legacyDb;
    let migratedDb;

    try {
      legacyDb = createAuthApp({ dbPath: legacyPath }).db;
      const firstId = legacyDb.prepare("INSERT INTO users (email, role, active) VALUES ('legacy-order-1@test.com', 'official', 1)").run().lastInsertRowid;
      const secondId = legacyDb.prepare("INSERT INTO users (email, role, active) VALUES ('legacy-order-2@test.com', 'official', 1)").run().lastInsertRowid;
      legacyDb.prepare("INSERT INTO ops_display (user_id) VALUES (?)").run(secondId);
      legacyDb.prepare("INSERT INTO ops_display (user_id) VALUES (?)").run(firstId);
      legacyDb.exec("ALTER TABLE ops_display DROP COLUMN sort_order");
      legacyDb.prepare("DELETE FROM schema_migrations WHERE name = 'auth.ops_contact_sort_order.v1'").run();
      legacyDb.close();
      legacyDb = null;

      migratedDb = createAuthApp({ dbPath: legacyPath }).db;
      const columns = migratedDb.prepare("PRAGMA table_info(ops_display)").all().map((column) => column.name);
      assert.ok(columns.includes('sort_order'));
      assert.deepEqual(
        migratedDb.prepare("SELECT user_id, sort_order FROM ops_display ORDER BY sort_order").all(),
        [
          { user_id: firstId, sort_order: 0 },
          { user_id: secondId, sort_order: 1 },
        ],
      );
    } finally {
      legacyDb?.close();
      migratedDb?.close();
      cleanup(legacyPath);
    }
  });
});

// ─── Ops Contacts (sidebar display) ─────────────────────────────────────
describe('Ops contacts', () => {
  let officialUserId, secondOfficialUserId;

  before(() => {
    // Ensure an official user exists for testing
    const user = db.prepare("SELECT id FROM users WHERE email = 'new@example.com'").get();
    db.prepare("UPDATE users SET role = 'official', active = 1 WHERE id = ?").run(user.id);
    officialUserId = user.id;
    secondOfficialUserId = db.prepare(
      "INSERT INTO users (email, role, active) VALUES ('ops-order@test.com', 'official', 1)",
    ).run().lastInsertRowid;
  });

  it('GET /api/ops-contacts returns empty array initially', async () => {
    const res = await client.get('/api/ops-contacts', { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('GET /api/ops-contacts requires official role (401 without auth)', async () => {
    const res = await client.get('/api/ops-contacts');
    assert.equal(res.status, 401);
  });

  it('GET /api/ops-contacts rejected for student role (403)', async () => {
    db.prepare("INSERT OR IGNORE INTO users (email, role, active) VALUES ('student@test.com', 'student', 1)").run();
    const res = await client.get('/api/ops-contacts', { cookie: studentCookie });
    assert.equal(res.status, 403);
  });

  it('POST /api/ops-contacts adds user to display list', async () => {
    const res = await client.post('/api/ops-contacts', {
      body: { user_id: officialUserId },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('POST /api/ops-contacts rejects missing user_id (400)', async () => {
    const res = await client.post('/api/ops-contacts', {
      body: {},
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/ops-contacts rejects student role user (400)', async () => {
    const student = db.prepare("SELECT id FROM users WHERE email = 'student@test.com'").get();
    const res = await client.post('/api/ops-contacts', {
      body: { user_id: student.id },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/ops-contacts accepts an admin user', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com'").get();
    const add = await client.post('/api/ops-contacts', {
      body: { user_id: admin.id },
      cookie: adminCookie,
    });
    assert.equal(add.status, 201);

    const remove = await client.delete(`/api/ops-contacts/${admin.id}`, { cookie: adminCookie });
    assert.equal(remove.status, 200);
  });

  it('POST /api/ops-contacts rejects non-existent user (404)', async () => {
    const res = await client.post('/api/ops-contacts', {
      body: { user_id: 99999 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/ops-contacts requires admin role (403 for official)', async () => {
    const res = await client.post('/api/ops-contacts', {
      body: { user_id: officialUserId },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('GET /api/contact-candidates requires admin role', async () => {
    const res = await client.get('/api/contact-candidates', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });

  it('PATCH /api/ops-contacts/:userId updates and trims the description', async () => {
    const res = await client.patch(`/api/ops-contacts/${officialUserId}`, {
      body: { description: '  검차 총괄  ' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { description: '검차 총괄' });
  });

  it('PATCH /api/ops-contacts/:userId rejects a missing request body', async () => {
    const res = await client.patch(`/api/ops-contacts/${officialUserId}`, {
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/ops-contacts/:userId rejects descriptions longer than 30 characters', async () => {
    const res = await client.patch(`/api/ops-contacts/${officialUserId}`, {
      body: { description: 'a'.repeat(31) },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/ops-contacts/:userId requires admin role', async () => {
    const res = await client.patch(`/api/ops-contacts/${officialUserId}`, {
      body: { description: '검차 총괄' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('PATCH /api/ops-contacts/:userId returns 404 for a non-displayed user', async () => {
    const res = await client.patch('/api/ops-contacts/99999', {
      body: { description: '검차 총괄' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('GET /api/ops-contacts returns displayed users', async () => {
    const res = await client.get('/api/ops-contacts', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.length >= 1);
    const contact = data.find(c => c.id === officialUserId);
    assert.ok(contact);
    assert.ok(contact.email);
    assert.equal(contact.description, '검차 총괄');
    assert.equal(contact.sort_order, 0);
  });

  it('POST /api/ops-contacts appends new contacts to the display order', async () => {
    const add = await client.post('/api/ops-contacts', {
      body: { user_id: secondOfficialUserId },
      cookie: adminCookie,
    });
    assert.equal(add.status, 201);

    const res = await client.get('/api/ops-contacts', { cookie: adminCookie });
    const data = await res.json();
    assert.deepEqual(data.map((contact) => contact.id), [officialUserId, secondOfficialUserId]);
  });

  it('POST /api/ops-contacts/reorder updates the sidebar order', async () => {
    const res = await client.post('/api/ops-contacts/reorder', {
      body: { user_ids: [secondOfficialUserId, officialUserId] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const check = await client.get('/api/ops-contacts', { cookie: officialCookie });
    const data = await check.json();
    assert.deepEqual(data.map((contact) => contact.id), [secondOfficialUserId, officialUserId]);
  });

  it('POST /api/ops-contacts/reorder keeps inactive contacts out of the active order', async () => {
    const deactivate = await client.patch(`/api/users/${secondOfficialUserId}`, {
      body: { active: false },
      cookie: adminCookie,
    });
    assert.equal(deactivate.status, 200);

    const reorder = await client.post('/api/ops-contacts/reorder', {
      body: { user_ids: [officialUserId] },
      cookie: adminCookie,
    });
    assert.equal(reorder.status, 200);

    const reactivate = await client.patch(`/api/users/${secondOfficialUserId}`, {
      body: { active: true },
      cookie: adminCookie,
    });
    assert.equal(reactivate.status, 200);

    const check = await client.get('/api/ops-contacts', { cookie: adminCookie });
    const data = await check.json();
    assert.deepEqual(data.map((contact) => contact.id), [officialUserId, secondOfficialUserId]);
  });

  it('POST /api/ops-contacts/reorder requires every displayed contact exactly once', async () => {
    const missing = await client.post('/api/ops-contacts/reorder', {
      body: { user_ids: [officialUserId] },
      cookie: adminCookie,
    });
    assert.equal(missing.status, 400);

    const duplicate = await client.post('/api/ops-contacts/reorder', {
      body: { user_ids: [officialUserId, officialUserId] },
      cookie: adminCookie,
    });
    assert.equal(duplicate.status, 400);
  });

  it('POST /api/ops-contacts/reorder requires admin role', async () => {
    const res = await client.post('/api/ops-contacts/reorder', {
      body: { user_ids: [secondOfficialUserId, officialUserId] },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });

  it('DELETE /api/ops-contacts/:userId removes from display list', async () => {
    const res = await client.delete(`/api/ops-contacts/${officialUserId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);

    const removeSecond = await client.delete(`/api/ops-contacts/${secondOfficialUserId}`, { cookie: adminCookie });
    assert.equal(removeSecond.status, 200);

    // Verify removal
    const check = await client.get('/api/ops-contacts', { cookie: adminCookie });
    const data = await check.json();
    assert.ok(!data.find(c => c.id === officialUserId));
    assert.ok(!data.find(c => c.id === secondOfficialUserId));
  });

  it('DELETE /api/ops-contacts/:userId returns 404 for non-displayed user', async () => {
    const res = await client.delete('/api/ops-contacts/99999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/ops-contacts/:userId requires admin role (403 for official)', async () => {
    const res = await client.delete('/api/ops-contacts/1', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });
});

// ─── OAuth (indirect tests) ─────────────────────────────────────────────
describe('OAuth endpoints', () => {
  it('GET /api/login redirects to Google (302)', async () => {
    const res = await client.get('/api/login', { headers: { redirect: 'manual' } });
    // fetch follows redirects by default; use low-level fetch to check redirect
    const rawRes = await fetch(`${baseUrl}/api/login`, { redirect: 'manual' });
    assert.equal(rawRes.status, 302);
    const location = rawRes.headers.get('location');
    assert.ok(location.includes('accounts.google.com'), 'should redirect to Google');
    assert.ok(location.includes('client_id=test-client-id'), 'should include client_id');
  });

  it('GET /api/login sets nonce cookie', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login`, { redirect: 'manual' });
    const setCookie = rawRes.headers.get('set-cookie');
    assert.ok(setCookie, 'should set cookie');
    assert.ok(setCookie.includes('fsk_oauth_nonce='), 'should set nonce cookie');
  });

  it('GET /api/login preserves redirect parameter in state', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=/entry`, { redirect: 'manual' });
    const location = rawRes.headers.get('location');
    // State is URL-encoded JSON containing the redirect
    assert.ok(location.includes('state='), 'should include state param');
    const url = new URL(location);
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/entry');
  });

  it('GET /api/login sanitizes absolute URL redirect', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=https://evil.com`, { redirect: 'manual' });
    const location = rawRes.headers.get('location');
    const url = new URL(location);
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/', 'absolute URLs should be sanitized to /');
  });

  it('GET /api/login sanitizes protocol-relative redirect', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=//evil.com`, { redirect: 'manual' });
    const location = rawRes.headers.get('location');
    const url = new URL(location);
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/', 'protocol-relative URLs should be sanitized to /');
  });

  it('GET /api/login sanitizes backslash protocol-relative redirect', async () => {
    // Browsers normalize a backslash after the leading slash into a slash, so
    // "/\evil.com" resolves to "//evil.com" → https://evil.com (open redirect).
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=${encodeURIComponent('/\\evil.com')}`, { redirect: 'manual' });
    const url = new URL(rawRes.headers.get('location'));
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/', 'backslash protocol-relative URLs should be sanitized to /');
  });

  it('GET /api/login sanitizes redirect with control characters', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=${encodeURIComponent('/\tevil')}`, { redirect: 'manual' });
    const url = new URL(rawRes.headers.get('location'));
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/', 'control characters should be sanitized to /');
  });

  it('GET /api/login preserves a legitimate absolute path redirect', async () => {
    const rawRes = await fetch(`${baseUrl}/api/login?redirect=${encodeURIComponent('/documents')}`, { redirect: 'manual' });
    const url = new URL(rawRes.headers.get('location'));
    const state = JSON.parse(url.searchParams.get('state'));
    assert.equal(state.redirect, '/documents', 'same-origin path should be preserved');
  });

  it('GET /api/callback redirects to landing on CSRF failure (no nonce cookie)', async () => {
    const state = JSON.stringify({ redirect: '/', nonce: 'fake-nonce' });
    const rawRes = await fetch(`${baseUrl}/api/callback?code=testcode&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    assert.equal(rawRes.status, 302);
    const location = rawRes.headers.get('location');
    assert.equal(location, '/?login_error=nonce', 'should redirect with nonce error');
  });

  it('GET /api/callback handles missing code with valid nonce', async () => {
    // First get a nonce from /api/login
    const loginRes = await fetch(`${baseUrl}/api/login`, { redirect: 'manual' });
    const setCookie = loginRes.headers.get('set-cookie');
    const nonceCookie = setCookie.split(';')[0]; // fsk_oauth_nonce=xxx

    const location = loginRes.headers.get('location');
    const url = new URL(location);
    const state = url.searchParams.get('state');

    // Call callback without code but with matching nonce
    const callbackRes = await fetch(`${baseUrl}/api/callback?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: nonceCookie },
    });
    assert.equal(callbackRes.status, 302);
    const callbackLocation = callbackRes.headers.get('location');
    assert.equal(callbackLocation, '/?login_error=cancelled', 'should redirect with cancelled error');
  });
});

// ─── Logout ──────────────────────────────────────────────────────────────
describe('POST /api/logout', () => {
  it('clears cookies on logout', async () => {
    const res = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'should set cookies');
    assert.ok(setCookie.includes('fsk_session=;'), 'should clear session cookie');
    assert.ok(setCookie.includes('fsk_user=;'), 'should clear user cookie');
    assert.ok(setCookie.includes('Max-Age=0'), 'should expire cookies');
  });

  it('requires auth (401 without cookie)', async () => {
    const res = await client.post('/api/logout');
    assert.equal(res.status, 401);
  });
});

// ─── Rate Limiting ───────────────────────────────────────────────────────
describe('Rate limiting', () => {
  it('redirects with login_error=rate_limit after 20 requests to /api/login', async () => {
    // Send 21 requests rapidly from the same IP
    const results = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${baseUrl}/api/login`, { redirect: 'manual' });
      results.push({ status: res.status, location: res.headers.get('location') });
    }

    // The 21st request (index 20) should be rate limited with a redirect
    const rateLimited = results.find(r => r.status === 302 && r.location?.includes('login_error=rate_limit'));
    assert.ok(rateLimited, 'should redirect with rate_limit error after exceeding rate limit');
  });

  // 무차별 대입 중 위반마다 warn을 남기면 초당 수십 행으로 로그 뷰어가 침수된다.
  // 윈도우당 첫 위반(count===21)만 기록해야 한다. 전용 IP로 다른 테스트와 격리.
  it('logs auth.rate_limit only once per window despite repeated violations', async () => {
    const ip = '198.51.100.42';
    for (let i = 0; i < 26; i++) {
      await fetch(`${baseUrl}/api/login`, { redirect: 'manual', headers: { 'X-Real-IP': ip } });
    }

    const rows = db.prepare(
      "SELECT level, detail FROM logs WHERE action = 'auth.rate_limit' AND detail LIKE ?",
    ).all(`%${ip}%`);
    assert.equal(rows.length, 1, 'exactly one warn for the whole window, not one per violation');
    assert.equal(rows[0].level, 'warn');
    assert.equal(JSON.parse(rows[0].detail).count, 21, 'the logged violation is the first one');
  });
});

// ─── Logs ────────────────────────────────────────────────────────────────
describe('GET /api/logs', () => {
  it('returns logs from previous operations', async () => {
    const res = await client.get('/api/logs', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.logs, 'should have logs array');
    assert.ok(Array.isArray(data.logs));
    assert.ok(data.logs.length > 0, 'should have logs from previous operations');
  });

  it('requires admin auth (401 without cookie)', async () => {
    const res = await client.get('/api/logs');
    assert.equal(res.status, 401);
  });

  it('requires admin role (403 for official)', async () => {
    const res = await client.get('/api/logs', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });
});

// ─── Admin Logs Aggregation ──────────────────────────────────────────────
describe('GET /api/admin/logs', () => {
  it('returns aggregated logs with service metadata', async () => {
    const res = await client.get('/api/admin/logs', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.logs, 'should have logs array');
    assert.ok(Array.isArray(data.logs));
    assert.ok(data.services, 'should have services array');
    assert.ok(data.services.includes('auth'));
    assert.ok(typeof data.total === 'number');
  });

  it('filters by service=auth', async () => {
    const res = await client.get('/api/admin/logs?service=auth', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.services.includes('auth'));
    assert.equal(data.services.length, 1);
  });

  it('supports limit and resumes via nextCursor without overlap', async () => {
    const page1 = await (await client.get('/api/admin/logs?service=auth&limit=2', { cookie: adminCookie })).json();
    assert.equal(page1.logs.length, 2);
    assert.ok(page1.nextCursor, 'page 1 should carry a nextCursor when more rows exist');

    const page2 = await (await client.get(
      `/api/admin/logs?service=auth&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      { cookie: adminCookie },
    )).json();
    const ids1 = new Set(page1.logs.map(l => l.id));
    assert.ok(page2.logs.every(l => !ids1.has(l.id)), 'pages must not overlap');
    const key = (l) => `${l.timestamp},${String(l.id).padStart(12, '0')}`;
    assert.ok(key(page2.logs[0]) < key(page1.logs[page1.logs.length - 1]), 'page 2 keys must be strictly older');
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await client.get('/api/admin/logs?cursor=not-a-token', { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('rejects a cursor made under different filters with 400', async () => {
    const page1 = await (await client.get('/api/admin/logs?service=auth&limit=2', { cookie: adminCookie })).json();
    assert.ok(page1.nextCursor);
    const res = await client.get(
      `/api/admin/logs?service=auth&level=warn&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      { cookie: adminCookie },
    );
    assert.equal(res.status, 400);
  });

  it('each log entry has _service field', async () => {
    const res = await client.get('/api/admin/logs?service=auth', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.logs.length > 0);
    assert.ok(data.logs.every((log) => log._service === 'auth'));
  });

  it('requires admin auth (401 without cookie)', async () => {
    const res = await client.get('/api/admin/logs');
    assert.equal(res.status, 401);
  });

  it('walks 6 cursor pages past the old 2000-row fetch horizon without gaps or duplicates', async () => {
    // Seed enough auth logs that page 6 must still return rows (regression: the offset
    // scheme's per-service fetch cap emptied deep pages while total said otherwise).
    const insert = db.prepare(
      "INSERT INTO logs (timestamp, module, level, actor_email, action, target) VALUES (?, 'auth', 'info', 'seed@test.com', 'logs.pagination_seed', ?)",
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < 620; i++) {
        insert.run(`2026-01-01T00:00:00.${String(1000 - (i % 1000)).padStart(4, '0')}Z`, `#${i}`);
      }
    });
    seed();

    const seen = new Set();
    let cursor = null;
    let lastPage = null;
    for (let p = 0; p < 6; p++) {
      const qs = `service=auth&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await client.get(`/api/admin/logs?${qs}`, { cookie: adminCookie });
      assert.equal(res.status, 200);
      lastPage = await res.json();
      for (const log of lastPage.logs) {
        assert.ok(!seen.has(log.id), `duplicate id ${log.id} across pages`);
        seen.add(log.id);
      }
      cursor = lastPage.nextCursor;
      if (p < 5) assert.ok(cursor, `page ${p + 1} should have a nextCursor`);
    }
    assert.ok(lastPage.logs.length > 0, 'page 6 must not be empty when >600 rows exist');
  });
});

// ─── Admin Logs Aggregation: multi-service merge ─────────────────────────
// LOG_SERVICES는 팩토리 생성 시점에 env를 읽으므로, COMPETITION_SERVER를 스텁으로 지정한
// 별도 앱 인스턴스를 만든다. 스텁은 logger.queryHandler와 같은 응답 형태를 흉내낸다.
describe('GET /api/admin/logs multi-service merge', () => {
  let stubServer, stubBehavior, mergeServer, mergeClient, mergeDb, mergeDbPath;
  const stubRows = [];

  before(async () => {
    // 스텁 entry: before 커서를 존중하는 keyset 응답
    for (let i = 0; i < 5; i++) {
      stubRows.push({
        id: 100 + i,
        timestamp: `2026-02-01T00:00:0${i}.000Z`,
        level: 'info', action: `entry.stub_${i}`, actor_email: null, actor_name: null,
        actor_role: null, target: null, detail: null, ip: null,
      });
    }
    stubRows.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id - a.id);
    stubBehavior = { fail: false };
    const http = await import('node:http');
    stubServer = http.createServer((req, res) => {
      if (stubBehavior.fail) { res.writeHead(500); return res.end('boom'); }
      const url = new URL(req.url, 'http://x');
      const limit = Number(url.searchParams.get('limit')) || 100;
      const before = url.searchParams.get('before');
      let rows = stubRows;
      if (before) {
        const idx = before.lastIndexOf(',');
        const [ts, id] = [before.slice(0, idx), Number(before.slice(idx + 1))];
        rows = rows.filter(r => r.timestamp < ts || (r.timestamp === ts && r.id < id));
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        logs: page, total: stubRows.length, service: 'entry',
        nextCursor: page.length === limit && last ? `${last.timestamp},${last.id}` : null,
        hasMore: page.length === limit,
      }));
    });
    await new Promise((r) => stubServer.listen(0, r));
    process.env.COMPETITION_SERVER = `http://localhost:${stubServer.address().port}`;

    mergeDbPath = tmpDbPath();
    const result = createAuthApp({ dbPath: mergeDbPath });
    mergeDb = result.db;
    // auth 쪽에도 스텁과 교차하는 타임스탬프의 로그를 심는다
    const insert = mergeDb.prepare(
      "INSERT INTO logs (timestamp, module, level, action) VALUES (?, 'auth', 'info', ?)",
    );
    for (let i = 0; i < 5; i++) {
      insert.run(`2026-02-01T00:00:0${i}.500Z`, `auth.stub_${i}`);
    }
    const started = await startServer(result.app);
    mergeServer = started.server;
    mergeClient = createClient(started.baseUrl);
  });

  after(async () => {
    delete process.env.COMPETITION_SERVER;
    await stopServer(mergeServer);
    if (stubServer) await new Promise((r) => stubServer.close(r));
    mergeDb.close();
    cleanup(mergeDbPath);
  });

  it('interleaves services in (timestamp,id) descending order and resumes per-service cursors', async () => {
    const page1 = await (await mergeClient.get('/api/admin/logs?service=auth,entry&limit=4', { cookie: adminCookie })).json();
    assert.equal(page1.logs.length, 4);
    // 병합 정렬 검증
    for (let i = 1; i < page1.logs.length; i++) {
      const a = page1.logs[i - 1], b = page1.logs[i];
      assert.ok(a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id >= b.id), 'descending merge order');
    }
    assert.ok(page1.logs.some(l => l._service === 'entry'), 'page 1 contains entry rows');
    assert.ok(page1.logs.some(l => l._service === 'auth'), 'page 1 contains auth rows');
    assert.ok(page1.nextCursor);

    const page2 = await (await mergeClient.get(
      `/api/admin/logs?service=auth,entry&limit=4&cursor=${encodeURIComponent(page1.nextCursor)}`,
      { cookie: adminCookie },
    )).json();
    const keys1 = new Set(page1.logs.map(l => `${l._service}:${l.id}`));
    assert.ok(page2.logs.every(l => !keys1.has(`${l._service}:${l.id}`)), 'no duplicates across pages');
    assert.ok(page2.logs.length > 0);
  });

  it('a failing service degrades gracefully: auth rows still return', async () => {
    stubBehavior.fail = true;
    try {
      const res = await mergeClient.get('/api/admin/logs?service=auth,entry&limit=4', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.logs.length > 0);
      assert.ok(data.logs.every(l => l._service === 'auth'), 'only auth rows when entry is down');
    } finally {
      stubBehavior.fail = false;
    }
  });
});

// ─── Session ────────────────────────────────────────────────────────────
describe('GET /api/session', () => {
  it('returns name and role for valid admin session', async () => {
    const res = await client.get('/api/session', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'Admin');
    assert.equal(data.role, 'admin');
  });

  it('returns correct role for student session', async () => {
    db.prepare("INSERT OR IGNORE INTO users (email, name, role, active) VALUES ('student@test.com', 'Student', 'student', 1)").run();
    const res = await client.get('/api/session', { cookie: studentCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'Student');
    assert.equal(data.role, 'student');
  });

  it('returns 401 without cookie', async () => {
    const res = await client.get('/api/session');
    assert.equal(res.status, 401);
  });

  it('returns 401 with invalid JWT', async () => {
    const res = await client.get('/api/session', { cookie: 'fsk_session=invalid.jwt.token' });
    assert.equal(res.status, 401);
  });
});

// ─── Forward Auth ───────────────────────────────────────────────────────
describe('GET /api/forward-auth', () => {
  it('returns 403 without X-Forward-Auth-Key header', async () => {
    const res = await client.get('/api/forward-auth', { cookie: adminCookie });
    assert.equal(res.status, 403);
  });

  it('returns 403 with wrong key', async () => {
    const res = await client.get('/api/forward-auth', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': 'wrong-secret' },
    });
    assert.equal(res.status, 403);
  });

  it('returns 403 for an empty forward-auth key', async () => {
    const res = await client.get('/api/forward-auth', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': '' },
    });
    assert.equal(res.status, 403);
  });

  it('returns 401 without user session', async () => {
    const res = await client.get('/api/forward-auth?permission=files.access', {
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 401);
  });

  it('rejects a missing or unknown permission', async () => {
    const missing = await client.get('/api/forward-auth', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(missing.status, 400);

    const unknown = await client.get('/api/forward-auth?permission=unknown.service', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(unknown.status, 400);
  });

  it('returns 403 when an official lacks the requested permission', async () => {
    db.prepare("INSERT OR IGNORE INTO users (email, name, role, active) VALUES ('official@test.com', 'Official', 'official', 1)").run();
    db.prepare("DELETE FROM user_permission WHERE user_id = (SELECT id FROM users WHERE email = 'official@test.com')").run();
    const res = await client.get('/api/forward-auth?permission=files.access', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 403);
  });

  it('authorizes an official through an explicit permission grant', async () => {
    const user = db.prepare("SELECT id FROM users WHERE email = 'official@test.com'").get();
    db.prepare("INSERT OR IGNORE INTO user_permission (user_id, permission_key) VALUES (?, 'files.access')").run(user.id);
    const res = await client.get('/api/forward-auth?permission=files.access', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-forwarded-user'), 'official@test.com');
  });

  it('expands management grants but keeps Queue and Inspection independent', async () => {
    const user = db.prepare("SELECT id FROM users WHERE email = 'official@test.com'").get();
    db.prepare("DELETE FROM user_permission WHERE user_id = ?").run(user.id);
    db.prepare("INSERT INTO user_permission (user_id, permission_key) VALUES (?, 'queue.manage')").run(user.id);
    const queue = await client.get('/api/forward-auth?permission=queue.operate', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(queue.status, 200);

    const inspection = await client.get('/api/forward-auth?permission=inspection.operate', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(inspection.status, 403);
  });

  it('lets an admin satisfy any known human permission', async () => {
    const res = await client.get('/api/forward-auth?permission=inspection.manage', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-forwarded-user'), 'admin@test.com');
  });
});

// ─── Edge Cases & Auth Middleware Integration ─────────────────────────────
describe('Auth middleware integration', () => {
  it('X-Internal-Service header is restricted to internal endpoints', async () => {
    const internal = await client.get('/api/users/access/admin@test.com', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(internal.status, 200);

    const users = await client.get('/api/internal/users', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(users.status, 200);
    const internalUsers = await users.json();
    assert.ok(internalUsers.some((user) => user.email === 'admin@test.com'));
    assert.equal('permissions' in internalUsers[0], false);
    assert.equal('protected' in internalUsers[0], false);

    const admin = await client.get('/api/users', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(admin.status, 403);
  });

  it('wrong X-Internal-Service header is explicitly rejected', async () => {
    const res = await client.get('/api/users', {
      headers: { 'X-Internal-Service': 'wrong-secret' },
    });
    assert.equal(res.status, 403);
  });

  it('expired JWT returns 401 on protected endpoints', async () => {
    const { createJWT } = await import('../../shared/express-setup.mjs');
    const expired = createJWT({ email: 'admin@test.com', name: 'Admin', role: 'admin' }, TEST_SECRET, -1);
    const res = await client.get('/api/users', { cookie: `fsk_session=${expired}` });
    assert.equal(res.status, 401);
  });

  it('invalid JWT token returns 401', async () => {
    const res = await client.get('/api/users', { cookie: 'fsk_session=invalid.token.here' });
    assert.equal(res.status, 401);
  });

  it('unknown API paths default to admin-only (fail-close)', async () => {
    const res = await client.get('/api/nonexistent');
    assert.equal(res.status, 401);
  });
});

// ─── 계정 신청 (Account Application) ───────────────────────────────────────
describe('Account applications', () => {
  let applicantCookie;

  before(async () => {
    const { createJWT } = await import('../../shared/express-setup.mjs');
    applicantCookie = (email, name) =>
      `fsk_applicant=${createJWT({ email, name, applicant: true }, TEST_SECRET, 3600)}`;
  });

  it('GET /api/apply/config is public and defaults to closed', async () => {
    const res = await client.get('/api/apply/config');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).open, false);
  });

  it('PATCH /api/applications/config requires admin (401 without cookie)', async () => {
    const res = await client.patch('/api/applications/config', { body: { open: true } });
    assert.equal(res.status, 401);
  });

  it('GET /api/applications rejects an official', async () => {
    const res = await client.get('/api/applications', { cookie: officialCookie });
    assert.equal(res.status, 403);
  });

  it('admin can open applications', async () => {
    const res = await client.patch('/api/applications/config', { body: { open: true }, cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await (await client.get('/api/apply/config')).json()).open, true);
  });

  it('GET /api/apply/me returns 401 without session or applicant cookie', async () => {
    const res = await client.get('/api/apply/me');
    assert.equal(res.status, 401);
  });

  it('GET /api/apply/me reports registered for a logged-in user', async () => {
    const res = await client.get('/api/apply/me', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).registered, true);
  });

  it('GET /api/apply/me returns application:null for a new applicant', async () => {
    const res = await client.get('/api/apply/me', { cookie: applicantCookie('alice@example.com', 'Alice') });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.registered, false);
    assert.equal(data.application, null);
    assert.equal(data.applicationsOpen, true);
    assert.equal(data.email, 'alice@example.com');
  });

  it('POST /api/apply rejects missing required fields (400)', async () => {
    const res = await client.post('/api/apply', {
      body: { realname: 'Alice', phone: '', affiliation: 'KU' },
      cookie: applicantCookie('alice@example.com', 'Alice'),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/apply creates an application', async () => {
    const c = applicantCookie('alice@example.com', 'Alice');
    const res = await client.post('/api/apply', {
      body: { realname: '앨리스', phone: '010-1111-2222', affiliation: '한국대 FSAE' },
      cookie: c,
    });
    assert.equal(res.status, 201);
    const me = await (await client.get('/api/apply/me', { cookie: c })).json();
    assert.ok(me.application);
    assert.equal(me.application.realname, '앨리스');
    assert.equal(me.application.affiliation, '한국대 FSAE');
  });

  it('POST /api/apply rejects a duplicate application (409)', async () => {
    const res = await client.post('/api/apply', {
      body: { realname: 'A', phone: '010-0000-0000', affiliation: 'X' },
      cookie: applicantCookie('alice@example.com', 'Alice'),
    });
    assert.equal(res.status, 409);
  });

  it('PATCH /api/apply updates the application', async () => {
    const c = applicantCookie('alice@example.com', 'Alice');
    const res = await client.patch('/api/apply', {
      body: { realname: '앨리스2', phone: '010-3333-4444', affiliation: '한국대 BAJA' },
      cookie: c,
    });
    assert.equal(res.status, 200);
    const me = await (await client.get('/api/apply/me', { cookie: c })).json();
    assert.equal(me.application.realname, '앨리스2');
    assert.equal(me.application.affiliation, '한국대 BAJA');
  });

  it('applicant cookie cannot access admin API /api/users (401)', async () => {
    const res = await client.get('/api/users', { cookie: applicantCookie('alice@example.com', 'Alice') });
    assert.equal(res.status, 401);
  });

  it('GET /api/applications lists pending applications (admin)', async () => {
    const res = await client.get('/api/applications', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const apps = await res.json();
    assert.ok(apps.some((a) => a.email === 'alice@example.com'));
  });

  it('POST /api/applications/approve creates users (copying affiliation) and clears the application', async () => {
    const apps = await (await client.get('/api/applications', { cookie: adminCookie })).json();
    const alice = apps.find((a) => a.email === 'alice@example.com');
    assert.ok(alice);
    const res = await client.post('/api/applications/approve', {
      body: { ids: [alice.id], role: 'student' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).added, 1);

    const users = await (await client.get('/api/users', { cookie: adminCookie })).json();
    const u = users.find((x) => x.email === 'alice@example.com');
    assert.ok(u);
    assert.equal(u.role, 'student');
    assert.equal(u.realname, '앨리스2');
    assert.equal(u.affiliation, '한국대 BAJA');

    const apps2 = await (await client.get('/api/applications', { cookie: adminCookie })).json();
    assert.ok(!apps2.some((a) => a.email === 'alice@example.com'));
  });

  it('POST /api/applications/approve rejects an invalid role (400)', async () => {
    const res = await client.post('/api/applications/approve', {
      body: { ids: [9999], role: 'superuser' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/apply rejects an already-registered user (409) and logs the rejection', async () => {
    const res = await client.post('/api/apply', {
      body: { realname: 'A', phone: '010-0000-0000', affiliation: 'X' },
      cookie: applicantCookie('alice@example.com', 'Alice'),
    });
    assert.equal(res.status, 409);

    // DB 기반 비즈니스 거절은 warn으로 관측 가능해야 한다(duplicate/closed와 동일).
    const row = db.prepare(
      "SELECT level, detail, target FROM logs WHERE action = 'applicant.apply' AND level = 'warn' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(row, 'the rejection must be logged');
    assert.match(row.detail, /already registered/);
    assert.equal(row.target, 'alice@example.com');
  });

  it('POST /api/apply is rejected when applications are closed (403) and logs the rejection', async () => {
    await client.patch('/api/applications/config', { body: { open: false }, cookie: adminCookie });
    const res = await client.post('/api/apply', {
      body: { realname: 'Bob', phone: '010-5555-6666', affiliation: 'Y' },
      cookie: applicantCookie('bob@example.com', 'Bob'),
    });
    assert.equal(res.status, 403);

    const row = db.prepare(
      "SELECT level, detail, target FROM logs WHERE action = 'applicant.apply' AND level = 'warn' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(row, 'the closed rejection must be logged');
    assert.match(row.detail, /closed/);
    assert.equal(row.target, 'bob@example.com');
  });
});

// ─── affiliation(학교/팀) on users ─────────────────────────────────────────
describe('users affiliation column', () => {
  it('PATCH /api/users/:id updates affiliation', async () => {
    const created = await (await client.post('/api/users', {
      body: { email: 'carol@example.com', role: 'official' },
      cookie: adminCookie,
    })).json();
    const res = await client.patch(`/api/users/${created.id}`, {
      body: { affiliation: '서울대 FSAE' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const users = await (await client.get('/api/users', { cookie: adminCookie })).json();
    assert.equal(users.find((u) => u.email === 'carol@example.com').affiliation, '서울대 FSAE');
  });

  it('POST /api/users/bulk accepts affiliation', async () => {
    const res = await client.post('/api/users/bulk', {
      body: { users: [{ email: 'dave@example.com', role: 'student', realname: 'Dave', phone: '010-7777-8888', affiliation: '연세대' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const users = await (await client.get('/api/users', { cookie: adminCookie })).json();
    assert.equal(users.find((u) => u.email === 'dave@example.com').affiliation, '연세대');
  });
});

// ─── OAuth callback → applicant branch ─────────────────────────────────────
describe('OAuth callback applicant branch', () => {
  // Drives the real /api/login → /api/callback flow with Google token/userinfo mocked.
  async function runCallback(email, name, redirect = undefined) {
    // Unique source IP so the per-IP OAuth rate limiter (20/min) doesn't trip
    // late in the suite after the many earlier login/callback calls.
    const xff = { 'X-Forwarded-For': '203.0.113.50' };
    const loginUrl = new URL(`${baseUrl}/api/login`);
    if (redirect) loginUrl.searchParams.set('redirect', redirect);
    const loginRes = await fetch(loginUrl, { redirect: 'manual', headers: xff });
    const nonceCookie = loginRes.headers.get('set-cookie').split(';')[0];
    const state = new URL(loginRes.headers.get('location')).searchParams.get('state');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ email, name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, opts);
    };
    try {
      return await origFetch(`${baseUrl}/api/callback?code=testcode&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { Cookie: nonceCookie, ...xff },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  it('unregistered login while OPEN issues an applicant cookie and redirects to /auth/apply', async () => {
    await client.patch('/api/applications/config', { body: { open: true }, cookie: adminCookie });
    const res = await runCallback('cb-applicant@example.com', 'CB Applicant', '/auth/apply');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/apply');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => /^fsk_applicant=[\w-]+\.[\w-]+\.[\w-]+/.test(c)), 'applicant cookie issued');
    assert.ok(!cookies.some((c) => /^fsk_session=[^;]/.test(c)), 'no full session issued');
    assert.equal(db.prepare("SELECT 1 FROM users WHERE email = 'cb-applicant@example.com'").get(), undefined);
  });

  it('unregistered sidebar login while OPEN is rejected and does not issue an applicant cookie', async () => {
    await client.patch('/api/applications/config', { body: { open: true }, cookie: adminCookie });
    const res = await runCallback('cb-sidebar@example.com', 'CB Sidebar', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?login_error=unregistered');
    const cookies = res.headers.getSetCookie();
    assert.ok(!cookies.some((c) => /^fsk_applicant=[^;]/.test(c)), 'no applicant cookie from non-apply login');
    assert.equal(db.prepare("SELECT 1 FROM users WHERE email = 'cb-sidebar@example.com'").get(), undefined);
  });

  it('unregistered login while CLOSED is rejected as before', async () => {
    await client.patch('/api/applications/config', { body: { open: false }, cookie: adminCookie });
    const res = await runCallback('cb-rejected@example.com', 'CB Rejected');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?login_error=unregistered');
    const cookies = res.headers.getSetCookie();
    assert.ok(!cookies.some((c) => /^fsk_applicant=[^;]/.test(c)), 'no applicant cookie when closed');
  });
});

// ─── OAuth callback → TEST_SERVER flag parsing ─────────────────────────────
describe('OAuth callback TEST_SERVER flag', () => {
  // Same mocked login→callback flow, but with a distinct source IP so the
  // per-IP OAuth rate limiter doesn't collide with the applicant-branch suite.
  async function runCallback(email, name, redirect = undefined) {
    const xff = { 'X-Forwarded-For': '203.0.113.77' };
    const loginUrl = new URL(`${baseUrl}/api/login`);
    if (redirect) loginUrl.searchParams.set('redirect', redirect);
    const loginRes = await fetch(loginUrl, { redirect: 'manual', headers: xff });
    const nonceCookie = loginRes.headers.get('set-cookie').split(';')[0];
    const state = new URL(loginRes.headers.get('location')).searchParams.get('state');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ email, name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, opts);
    };
    try {
      return await origFetch(`${baseUrl}/api/callback?code=testcode&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { Cookie: nonceCookie, ...xff },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  let savedTestServer;
  before(() => { savedTestServer = process.env.TEST_SERVER; });
  after(() => {
    if (savedTestServer === undefined) delete process.env.TEST_SERVER;
    else process.env.TEST_SERVER = savedTestServer;
  });

  it('TEST_SERVER="false" does NOT auto-register an unregistered user (the string-truthy footgun)', async () => {
    process.env.TEST_SERVER = 'false';
    await client.patch('/api/applications/config', { body: { open: false }, cookie: adminCookie });
    const email = 'ts-false@example.com';
    const res = await runCallback(email, 'TS False', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?login_error=unregistered', 'must be rejected, not auto-registered');
    assert.equal(db.prepare('SELECT 1 FROM users WHERE email = ?').get(email), undefined, 'no user row created');
    const cookies = res.headers.getSetCookie();
    assert.ok(!cookies.some((c) => /^fsk_session=[^;]/.test(c)), 'no session issued');
  });

  it('TEST_SERVER="true" auto-registers an unregistered user as admin', async () => {
    process.env.TEST_SERVER = 'true';
    const email = 'ts-true@example.com';
    const res = await runCallback(email, 'TS True', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/', 'logged in and redirected');
    const row = db.prepare('SELECT role, active FROM users WHERE email = ?').get(email);
    assert.ok(row, 'user row created');
    assert.equal(row.role, 'admin');
    assert.equal(row.active, 1);
  });
});

// ─── Account applications - edge cases ─────────────────────────────────────
describe('Account applications - edge cases', () => {
  let applicantCookie;

  before(async () => {
    const { createJWT } = await import('../../shared/express-setup.mjs');
    applicantCookie = (email, name) => `fsk_applicant=${createJWT({ email, name, applicant: true }, TEST_SECRET, 3600)}`;
    await client.patch('/api/applications/config', { body: { open: true }, cookie: adminCookie });
  });

  it('PATCH /api/apply returns 404 when no application exists', async () => {
    const res = await client.patch('/api/apply', {
      body: { realname: 'X', phone: '010-0000-0000', affiliation: 'Y' },
      cookie: applicantCookie('noapp@example.com', 'NoApp'),
    });
    assert.equal(res.status, 404);
  });

  it('PATCH /api/apply rejects missing fields (400)', async () => {
    const c = applicantCookie('edit-missing@example.com', 'EM');
    await client.post('/api/apply', { body: { realname: 'A', phone: '010-1111-1111', affiliation: 'B' }, cookie: c });
    const res = await client.patch('/api/apply', { body: { realname: '', phone: '010-1111-1111', affiliation: 'B' }, cookie: c });
    assert.equal(res.status, 400);
  });

  it('GET /api/apply/me rejects a malformed applicant cookie (401)', async () => {
    const res = await client.get('/api/apply/me', { cookie: 'fsk_applicant=not.a.valid.jwt' });
    assert.equal(res.status, 401);
  });

  it('POST /api/applications/approve rejects empty ids (400)', async () => {
    const res = await client.post('/api/applications/approve', { body: { ids: [], role: 'student' }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('POST /api/applications/approve reports skipped for an already-registered email', async () => {
    db.prepare("INSERT OR IGNORE INTO applications (email, name, realname, phone, affiliation) VALUES ('admin@test.com', 'Admin', 'A', '010', 'X')").run();
    const app = db.prepare("SELECT id FROM applications WHERE email = 'admin@test.com'").get();
    const res = await client.post('/api/applications/approve', { body: { ids: [app.id], role: 'student' }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 0);
    assert.equal(data.skipped, 1);
    assert.equal(db.prepare("SELECT 1 FROM applications WHERE email = 'admin@test.com'").get(), undefined);
  });

  it('DELETE /api/applications requires admin (401 without cookie)', async () => {
    const res = await client.delete('/api/applications', { body: { ids: [1] } });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/applications rejects empty ids (400)', async () => {
    const res = await client.delete('/api/applications', { body: { ids: [] }, cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('DELETE /api/applications removes selected applications without creating a user', async () => {
    db.prepare("INSERT OR IGNORE INTO applications (email, name, realname, phone, affiliation) VALUES ('del-app@example.com', 'Del', 'D', '010-0000-0000', 'Team')").run();
    const app = db.prepare("SELECT id FROM applications WHERE email = 'del-app@example.com'").get();
    const res = await client.delete('/api/applications', { body: { ids: [app.id] }, cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deleted, 1);
    assert.equal(db.prepare("SELECT 1 FROM applications WHERE id = ?").get(app.id), undefined, 'application removed');
    assert.equal(db.prepare("SELECT 1 FROM users WHERE email = 'del-app@example.com'").get(), undefined, 'no user created');
  });
});
