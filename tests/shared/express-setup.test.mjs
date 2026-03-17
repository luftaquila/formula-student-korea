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
} from '../../shared/express-setup.mjs';

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
  let server, client;

  // Track validateUser calls
  let validateUserResult = { valid: true, role: null };
  const validateUser = async (email) => {
    if (typeof validateUserResult === 'function') return validateUserResult(email);
    return validateUserResult;
  };

  before(async () => {
    const app = createApp({ express, validateUser }, (req) => {
      if (req.path === '/public') return null;
      if (req.path === '/admin') return 'admin';
      if (req.path === '/official') return 'official';
      return 'student';
    });
    app.get('/public', (req, res) => res.json({ user: req.user?.email || null }));
    app.get('/admin', (req, res) => res.json({ user: req.user.email }));
    app.get('/official', (req, res) => res.json({ user: req.user.email }));
    app.get('/student', (req, res) => res.json({ user: req.user.email }));

    const started = await startServer(app);
    server = started.server;
    client = createClient(started.baseUrl);
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

  // Auth: no auth on protected endpoint
  it('protected endpoint without auth returns 401', async () => {
    const res = await client.get('/student');
    assert.equal(res.status, 401);
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
  it('expired JWT returns 401', async () => {
    const expired = createJWT({ email: 'user@test.com', name: 'User', role: 'student' }, TEST_SECRET, -1);
    const res = await client.get('/student', { cookie: `fsk_session=${expired}` });
    assert.equal(res.status, 401);
  });

  // Auth: insufficient role
  it('student cannot access admin endpoint (403)', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'student' });
    const res = await client.get('/admin', { cookie });
    assert.equal(res.status, 403);
  });

  // Auth: invalid role not in VALID_ROLES
  it('invalid role not in VALID_ROLES returns 403', async () => {
    validateUserResult = { valid: true, role: null };
    const cookie = makeAuthCookie({ email: 'user@test.com', name: 'User', role: 'superuser' });
    const res = await client.get('/student', { cookie });
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

  // Auth: dev mode
  it('dev mode auto-authenticates as admin when JWT_SECRET is unset', async () => {
    const savedSecret = process.env.JWT_SECRET;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'development';

    try {
      // Need a fresh app for dev mode since env is read at createApp time
      const devApp = createApp({ express }, (req) => {
        if (req.path === '/dev-test') return 'admin';
        return null;
      });
      devApp.get('/dev-test', (req, res) => res.json({ user: req.user.email }));

      const { server: devServer, baseUrl } = await startServer(devApp);
      const devClient = createClient(baseUrl);

      const res = await devClient.get('/dev-test');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user, 'dev@local');

      await stopServer(devServer);
    } finally {
      process.env.JWT_SECRET = savedSecret;
      if (savedNodeEnv !== undefined) {
        process.env.NODE_ENV = savedNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    }
  });

  // Auth: validateUser returning invalid
  it('validateUser returning {valid:false} clears cookies and returns 401', async () => {
    validateUserResult = { valid: false, role: null };
    const cookie = makeAuthCookie({ email: 'gone@test.com', name: 'Gone', role: 'student' });
    const res = await client.get('/student', { cookie });
    assert.equal(res.status, 401);
    // Check that Set-Cookie is present to clear the session
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'should have Set-Cookie header');
    assert.ok(setCookie.includes('Max-Age=0'), 'should clear cookie with Max-Age=0');
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
});
