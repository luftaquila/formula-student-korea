import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');

import {
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  setupTestEnv,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import {
  createJWT,
  createApp,
  createDbRun,
  isSecureConnection,
  formatCookieOpts,
  VALID_ROLES,
  isEnvEnabled,
} from '../../shared/express-setup.mjs';

// ─── isEnvEnabled ─────────────────────────────────────────────────────────
describe('isEnvEnabled', () => {
  it('treats "1"/"true"/"yes"/"on" (any case) as enabled', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', '  true  ']) {
      assert.equal(isEnvEnabled(v), true, `"${v}" should be enabled`);
    }
  });

  it('treats "false"/"0"/""/undefined/null as disabled', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', '', ' ', undefined, null]) {
      assert.equal(isEnvEnabled(v), false, `${JSON.stringify(v)} should be disabled`);
    }
  });
});

// ─── createJWT ──────────────────────────────────────────────────────────
describe('createJWT', () => {
  it('creates a valid JWT that can be decoded', () => {
    const token = createJWT({ email: 'a@b.com', name: 'A', role: 'admin' }, TEST_SECRET);
    const parts = token.split('.');
    assert.equal(parts.length, 3);

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.equal(payload.email, 'a@b.com');
    assert.equal(payload.role, 'admin');
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  });

  it('creates an expired token when expiresInSec is negative', () => {
    const token = createJWT({ email: 'a@b.com', name: 'A', role: 'admin' }, TEST_SECRET, -1);
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.ok(payload.exp <= Math.floor(Date.now() / 1000));
  });
});

// ─── createDbRun ────────────────────────────────────────────────────────
describe('createDbRun', () => {
  const dbRun = createDbRun();

  it('returns success with result on normal execution', () => {
    const res = dbRun(() => 42);
    assert.deepEqual(res, { success: true, result: 42 });
  });

  it('returns 400 on SQLITE_CONSTRAINT_PRIMARYKEY', () => {
    const res = dbRun(() => {
      const e = new Error('PK violation');
      e.code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
      throw e;
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 400);
  });

  it('returns 400 on SQLITE_CONSTRAINT_UNIQUE', () => {
    const res = dbRun(() => {
      const e = new Error('UNIQUE violation');
      e.code = 'SQLITE_CONSTRAINT_UNIQUE';
      throw e;
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 400);
  });

  it('passes through custom error with status and message', () => {
    const res = dbRun(() => {
      throw { status: 409, message: 'Conflict' };
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'Conflict');
  });

  it('returns 500 on generic error', () => {
    const res = dbRun(() => {
      throw new Error('something broke');
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 500);
  });
});

// ─── isSecureConnection ─────────────────────────────────────────────────
describe('isSecureConnection', () => {
  it('returns true when x-forwarded-proto is https', () => {
    const req = { headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' };
    assert.equal(isSecureConnection(req), true);
  });

  it('returns false when x-forwarded-proto is http', () => {
    const req = { headers: { 'x-forwarded-proto': 'http' }, protocol: 'http' };
    assert.equal(isSecureConnection(req), false);
  });

  it('falls back to req.protocol when header absent', () => {
    const req = { headers: {}, protocol: 'https' };
    assert.equal(isSecureConnection(req), true);
  });

  it('returns false for plain http without header', () => {
    const req = { headers: {}, protocol: 'http' };
    assert.equal(isSecureConnection(req), false);
  });
});

// ─── formatCookieOpts ───────────────────────────────────────────────────
describe('formatCookieOpts', () => {
  it('includes Secure flag when isSecure is true', () => {
    const opts = formatCookieOpts(3600, true);
    assert.ok(opts.includes('Secure'));
    assert.ok(opts.includes('Max-Age=3600'));
    assert.ok(opts.includes('Path=/'));
    assert.ok(opts.includes('SameSite=Lax'));
  });

  it('omits Secure flag when isSecure is false', () => {
    const opts = formatCookieOpts(3600, false);
    assert.ok(!opts.includes('Secure'));
    assert.ok(opts.includes('Max-Age=3600'));
  });
});

// ─── Cookie parsing & Auth middleware (via createApp) ───────────────────
describe('createApp auth middleware', () => {
  let server, client, baseUrl;

  // Track validateUser calls
  let validateUserResult = { valid: true, role: null };
  const validateUser = async (email) => {
    if (typeof validateUserResult === 'function') return validateUserResult(email);
    return validateUserResult;
  };

  before(async () => {
    const app = createApp({ express, validateUser }, (req) => {
      if (req.path === '/public') return null;
      if (req.path === '/admin' || req.path === '/api/admin') return 'admin';
      if (req.path === '/official' || req.path === '/api/official') return 'official';
      if (req.path.startsWith('/api/')) return 'student';
      return 'student';
    });
    app.get('/public', (req, res) => res.json({ user: req.user?.email || null }));
    app.get('/admin', (req, res) => res.json({ user: req.user.email }));
    app.get('/official', (req, res) => res.json({ user: req.user.email }));
    app.get('/student', (req, res) => res.json({ user: req.user.email }));
    app.get('/api/admin', (req, res) => res.json({ user: req.user.email }));
    app.get('/api/student', (req, res) => res.json({ user: req.user.email }));

    const started = await startServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
    client = createClient(baseUrl);
  });

  after(async () => {
    if (server) await stopServer(server);
  });

  // Cookie parsing
  it('parses valid cookies', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'admin' });
    const res = await client.get('/admin', { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user, 'user@test.com');
  });

  it('handles malformed percent-encoding in cookies gracefully', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'admin' });
    // Add a malformed cookie alongside the valid one
    const res = await client.get('/admin', { cookie: `bad=%E0%A4; ${cookie}` });
    assert.equal(res.status, 200);
  });

  it('handles empty cookie header', async () => {
    const res = await client.get('/public', { headers: { Cookie: '' } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user, null);
  });

  // Auth: public endpoint
  it('public endpoint accessible without auth', async () => {
    const res = await client.get('/public');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user, null);
  });

  // Auth: no auth on protected API endpoint
  it('protected API endpoint without auth returns 401', async () => {
    const res = await client.get('/api/student');
    assert.equal(res.status, 401);
  });

  // Auth: no auth on protected SPA page redirects to landing
  it('protected SPA page without auth redirects to /', async () => {
    const res = await fetch(`${baseUrl}/student`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  // Auth: valid JWT
  it('valid JWT authenticates successfully', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    const res = await client.get('/student', { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user, 'user@test.com');
  });

  // Auth: expired JWT
  it('expired JWT returns 401 on API endpoint', async () => {
    const expired = createJWT({ email: 'user@test.com', name: 'User', role: 'student' }, TEST_SECRET, -1);
    const res = await client.get('/api/student', { cookie: `fsk_session=${expired}` });
    assert.equal(res.status, 401);
  });

  // Auth: insufficient role
  it('student cannot access admin API endpoint (403)', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    const res = await client.get('/api/admin', { cookie });
    assert.equal(res.status, 403);
  });

  // Auth: insufficient role on SPA page redirects
  it('student accessing admin SPA page redirects to /', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    const res = await fetch(`${baseUrl}/admin`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  // Auth: invalid role not in VALID_ROLES
  it('invalid role not in VALID_ROLES returns 403 on API endpoint', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'superuser' });
    const res = await client.get('/api/student', { cookie });
    assert.equal(res.status, 403);
  });

  // Auth: X-Internal-Service header
  it('X-Internal-Service header authenticates as admin', async () => {
    const res = await client.get('/admin', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user, 'internal');
  });

  it('wrong X-Internal-Service header is explicitly rejected with 403', async () => {
    const res = await client.get('/admin', {
      headers: { 'X-Internal-Service': 'wrong-secret' },
    });
    assert.equal(res.status, 403);
  });

  // Auth: validateUser returning invalid
  it('validateUser returning {valid:false} clears cookies and returns 401', async () => {
    validateUserResult = { valid: false, role: null };
    const cookie = makeAuthCookie({ email: 'gone@test.com', name: 'Gone', role: 'student' });
    const res = await client.get('/api/student', { cookie });
    assert.equal(res.status, 401);
    // Check that Set-Cookie is present to clear the session
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'should have Set-Cookie header');
    assert.ok(setCookie.includes('Max-Age=0'), 'should clear cookie with Max-Age=0');
  });

  // Transient auth outage (5xx/network) must deny the request (fail-close) but
  // preserve the session cookie so recovery doesn't force everyone to re-OAuth.
  it('validateUser transient failure returns 401 but does NOT clear the session cookie', async () => {
    validateUserResult = { valid: false, role: null, transient: true };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    const res = await client.get('/api/student', { cookie });
    assert.equal(res.status, 401);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(!setCookie || !setCookie.includes('Max-Age=0'), 'transient failure must not clear cookies');
  });

  // Auth: validateUser returning changed role
  it('validateUser returning changed role updates cookie', async () => {
    validateUserResult = { valid: true, role: 'chief' };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    // Access an endpoint that student can access but chief can too
    const res = await client.get('/student', { cookie });
    assert.equal(res.status, 200);
    // Should have a Set-Cookie with updated role
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'should have Set-Cookie header for role update');
    assert.ok(setCookie.includes('fsk_session='), 'should include new session token');
  });

  // Sliding session: token near expiry gets refreshed
  it('sliding session refreshes token when remaining time < 6 days', async () => {
    validateUserResult = { valid: true, role: null };
    // Create a token that expires in 5 days (less than 6-day threshold)
    const shortLived = createJWT(
      { email: 'user@test.com', name: 'User', role: 'admin' },
      TEST_SECRET,
      5 * 24 * 3600,
    );
    const res = await client.get('/admin', { cookie: `fsk_session=${shortLived}` });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'should have Set-Cookie for sliding session');
    assert.ok(setCookie.includes('fsk_session='), 'should include refreshed session token');
  });

  // ─── Path canonicalization: gate must not be slipped by case / trailing slash ──
  // Express routing is case-insensitive and trailing-slash-insensitive, so
  // `/API/admin` and `/api/admin/` reach the `/api/admin` handler. The gate
  // compares req.path, so without canonicalization those variants fall through
  // to the weaker default role (here 'student') and bypass the admin gate.
  it('uppercase path prefix cannot bypass the admin gate', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'u@test.com', name: 'U', role: 'student' });
    const res = await client.get('/API/admin', { cookie });
    assert.equal(res.status, 403);
  });

  it('mixed-case path prefix cannot bypass the admin gate', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'u@test.com', name: 'U', role: 'student' });
    const res = await client.get('/Api/Admin', { cookie });
    assert.equal(res.status, 403);
  });

  it('trailing slash cannot bypass the admin gate', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'u@test.com', name: 'U', role: 'student' });
    const res = await client.get('/api/admin/', { cookie });
    assert.equal(res.status, 403);
  });

  it('uppercase public path still resolves as public (canonicalization must not over-gate)', async () => {
    const res = await client.get('/PUBLIC');
    assert.equal(res.status, 200);
  });
});

// ─── createSecretChecker ────────────────────────────────────────────────
import { createSecretChecker } from '../../shared/express-setup.mjs';

describe('createSecretChecker', () => {
  it('matches only the exact secret', () => {
    const check = createSecretChecker('s3cret');
    assert.equal(check('s3cret'), true);
    assert.equal(check('s3creT'), false);
    assert.equal(check('s3cret '), false);
  });

  it('returns false for empty/non-string values and unset secret', () => {
    const check = createSecretChecker('s3cret');
    assert.equal(check(''), false);
    assert.equal(check(undefined), false);
    assert.equal(check(['s3cret']), false);
    const noSecret = createSecretChecker(undefined);
    assert.equal(noSecret('anything'), false);
  });
});

// ─── CSRF (Sec-Fetch-Site) 심층방어 ─────────────────────────────────────
describe('createApp CSRF middleware', () => {
  let server, baseUrl;

  before(async () => {
    const app = createApp({ express, validateUser: async () => ({ valid: true, role: 'admin' }) }, () => null);
    app.post('/api/write', (req, res) => res.json({ ok: true }));
    app.get('/api/read', (req, res) => res.json({ ok: true }));
    const started = await startServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    if (server) await stopServer(server);
  });

  it('blocks cross-site write requests', async () => {
    const res = await fetch(`${baseUrl}/api/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });

  it('allows same-origin and header-less write requests', async () => {
    for (const headers of [
      { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'none' },
      { 'Content-Type': 'application/json' }, // 내부 서비스·rover·구형 클라이언트
    ]) {
      const res = await fetch(`${baseUrl}/api/write`, { method: 'POST', headers, body: '{}' });
      assert.equal(res.status, 200);
    }
  });

  it('never blocks reads (GET) regardless of Sec-Fetch-Site', async () => {
    const res = await fetch(`${baseUrl}/api/read`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 200);
  });
});
