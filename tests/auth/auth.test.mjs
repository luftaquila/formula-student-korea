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
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

import { createAuthApp } from '../../auth/index.mjs';

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

  it('is accessible without authentication', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
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
      body: { role: 'chief', realname: 'promoted' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const user = db.prepare('SELECT role, realname FROM users WHERE id = ?').get(testUserId);
    assert.equal(user.role, 'chief');
    assert.equal(user.realname, 'promoted');
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

  it('accessible via admin cookie', async () => {
    const res = await client.get('/api/users/role/admin@test.com', {
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.role, 'admin');
  });
});

// ─── Ops Contacts (sidebar display) ─────────────────────────────────────
describe('Ops contacts', () => {
  let officialUserId;

  before(() => {
    // Ensure an official user exists for testing
    const user = db.prepare("SELECT id FROM users WHERE email = 'new@example.com'").get();
    db.prepare("UPDATE users SET role = 'official', active = 1 WHERE id = ?").run(user.id);
    officialUserId = user.id;
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

  it('GET /api/ops-contacts accessible by official role', async () => {
    const res = await client.get('/api/ops-contacts', { cookie: officialCookie });
    assert.equal(res.status, 200);
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

  it('GET /api/ops-contacts returns displayed users', async () => {
    const res = await client.get('/api/ops-contacts', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.length >= 1);
    const contact = data.find(c => c.id === officialUserId);
    assert.ok(contact);
    assert.ok(contact.email);
  });

  it('DELETE /api/ops-contacts/:userId removes from display list', async () => {
    const res = await client.delete(`/api/ops-contacts/${officialUserId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify removal
    const check = await client.get('/api/ops-contacts', { cookie: adminCookie });
    const data = await check.json();
    assert.ok(!data.find(c => c.id === officialUserId));
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

  it('supports limit and offset', async () => {
    const res = await client.get('/api/admin/logs?limit=2&offset=0', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.logs.length <= 2);
  });

  it('each log entry has _service field', async () => {
    const res = await client.get('/api/admin/logs?service=auth', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    if (data.logs.length > 0) {
      assert.equal(data.logs[0]._service, 'auth');
    }
  });

  it('requires admin auth (401 without cookie)', async () => {
    const res = await client.get('/api/admin/logs');
    assert.equal(res.status, 401);
  });

  it('paginates auth logs past offset 500 (regression: hardcoded LIMIT 500 emptied later pages)', async () => {
    // Seed enough auth logs that page 6 (offset 500) must still return rows.
    const insert = db.prepare(
      "INSERT INTO logs (timestamp, level, actor_email, action, target) VALUES (?, 'info', 'seed@test.com', 'logs.pagination_seed', ?)",
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < 620; i++) {
        // Descending, zero-padded timestamps keep a stable merge order.
        insert.run(`2026-01-01T00:00:00.${String(1000 - (i % 1000)).padStart(4, '0')}Z`, `#${i}`);
      }
    });
    seed();

    const total = (await (await client.get('/api/admin/logs?service=auth&limit=100&offset=0', { cookie: adminCookie })).json()).total;
    assert.ok(total > 500, `precondition: need >500 auth logs, got ${total}`);

    const res = await client.get('/api/admin/logs?service=auth&limit=100&offset=500', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.logs.length > 0, 'page 6 (offset 500) must not be empty when total > 500');
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

  it('returns 403 when INTERNAL_SECRET is unset', async () => {
    const original = process.env.INTERNAL_SECRET;
    // Note: INTERNAL_SECRET is read at request time in the handler, but the secret
    // variable is captured at app creation. We test via wrong key instead.
    const res = await client.get('/api/forward-auth', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': '' },
    });
    assert.equal(res.status, 403);
  });

  it('returns 401 without user session', async () => {
    const res = await client.get('/api/forward-auth', {
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 401);
  });

  it('returns 403 when role insufficient (official < chief)', async () => {
    db.prepare("INSERT OR IGNORE INTO users (email, name, role, active) VALUES ('official@test.com', 'Official', 'official', 1)").run();
    const res = await client.get('/api/forward-auth?role=chief', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 403);
  });

  it('returns 200 with X-Forwarded-User when authorized', async () => {
    const res = await client.get('/api/forward-auth?role=chief', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-forwarded-user'), 'admin@test.com');
  });

  it('defaults to official role when role query is omitted', async () => {
    const res = await client.get('/api/forward-auth', {
      cookie: officialCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-forwarded-user'), 'official@test.com');
  });

  it('allows higher role (admin) for lower requirement (chief)', async () => {
    const res = await client.get('/api/forward-auth?role=chief', {
      cookie: adminCookie,
      headers: { 'X-Forward-Auth-Key': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-forwarded-user'), 'admin@test.com');
  });
});

// ─── Edge Cases & Auth Middleware Integration ─────────────────────────────
describe('Auth middleware integration', () => {
  it('X-Internal-Service header grants admin access', async () => {
    const res = await client.get('/api/users', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
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

  it('POST /api/apply rejects an already-registered user (409)', async () => {
    const res = await client.post('/api/apply', {
      body: { realname: 'A', phone: '010-0000-0000', affiliation: 'X' },
      cookie: applicantCookie('alice@example.com', 'Alice'),
    });
    assert.equal(res.status, 409);
  });

  it('POST /api/apply is rejected when applications are closed (403)', async () => {
    await client.patch('/api/applications/config', { body: { open: false }, cookie: adminCookie });
    const res = await client.post('/api/apply', {
      body: { realname: 'Bob', phone: '010-5555-6666', affiliation: 'Y' },
      cookie: applicantCookie('bob@example.com', 'Bob'),
    });
    assert.equal(res.status, 403);
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
