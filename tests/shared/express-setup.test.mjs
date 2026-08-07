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
  TRUST_JWT,
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

// ─── Remote user revalidation (default-on) ────────────────────────────────
// 이 블록은 "AUTH_SERVER env가 있을 때만 재검증"이던 구멍의 회귀 방지용이다. 그때는
// URL을 빠뜨리면 validateUser가 null이 되어 JWT가 무검증으로 신뢰됐고, 삭제·강등된
// 사용자가 세션 만료(최대 7일)까지 권한을 유지했다. 이제 URL은 레지스트리 상수에서
// 오므로 env 없이도 재검증이 돌아야 하고, 끄는 방법은 검증기 주입뿐이다.
describe('remote user revalidation', () => {
  const cookie = makeAuthCookie({ email: 'u@test.com', name: 'U', role: 'admin' });

  async function withApp(deps, fn) {
    const app = createApp({ express, ...deps }, () => 'admin');
    app.get('/api/admin', (req, res) => res.json({ user: req.user.email, role: req.user.role }));
    const started = await startServer(app);
    try {
      await fn(createClient(started.baseUrl));
    } finally {
      await stopServer(started.server);
    }
  }

  const priorAuthServer = process.env.AUTH_SERVER;
  after(() => {
    // 이 블록이 파일 끝이 아니게 될 때를 대비해 되돌린다.
    if (priorAuthServer === undefined) delete process.env.AUTH_SERVER;
    else process.env.AUTH_SERVER = priorAuthServer;
  });

  it('revalidates without AUTH_SERVER set, using the registry default', async () => {
    delete process.env.AUTH_SERVER;
    await withApp({}, async (client) => {
      // 레지스트리 기본값(http://auth:9100)은 테스트 머신에서 닿지 않는다 → transient →
      // fail-close. 요청이 거부된다는 것이 곧 재검증이 시도됐다는 증거다. 구현이
      // 회귀해 validateUser가 null이 되면 JWT가 그대로 신뢰돼 200이 나온다.
      const res = await client.get('/api/admin', { cookie });
      assert.equal(res.status, 401, 'an unreachable auth service must not be treated as "user is valid"');
      // transient 장애에서는 쿠키를 보존해 복구 후 재-OAuth 없이 세션이 이어져야 한다.
      assert.equal(res.headers.get('set-cookie'), null, 'a transient failure must not clear the session');
    });
  });

  it('an injected validator is the only way to skip the HTTP round-trip', async () => {
    delete process.env.AUTH_SERVER;
    await withApp({ validateUser: TRUST_JWT }, async (client) => {
      const res = await client.get('/api/admin', { cookie });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).user, 'u@test.com');
    });
  });

  it('an injected validator still propagates deletion and demotion', async () => {
    delete process.env.AUTH_SERVER;
    await withApp({ validateUser: async () => ({ valid: false, role: null }) }, async (client) => {
      const res = await client.get('/api/admin', { cookie });
      assert.equal(res.status, 401, 'deleted user is rejected');
      // 확정 무효는 transient와 달리 쿠키를 지운다.
      assert.match(res.headers.get('set-cookie') || '', /fsk_session=;/, 'a confirmed deletion clears the session');
    });
    await withApp({ validateUser: async () => ({ valid: true, role: 'student' }) }, async (client) => {
      // 강등은 라우트 접근을 막고(admin 전용), 주입이 재검증을 우회하지 못함을 보인다.
      assert.equal((await client.get('/api/admin', { cookie })).status, 403, 'demoted user loses admin');
    });
  });

  // 주입된 검증기의 예외는 내장 HTTP 검증기의 네트워크 오류와 같게 다뤄야 한다. 감싸지
  // 않으면 Express 5가 에러 핸들러로 보내 500이 되고, 같은 예외를 sse.mjs는 fail-open으로
  // 처리해 한 stub이 소비자마다 반대로 동작한다. auth의 검증기가 db 오류로 던질 수 있다.
  it('treats a throwing validator as a transient failure, not a 500', async () => {
    delete process.env.AUTH_SERVER;
    // 내장 경로와 같은 조건에서 로그를 남기는지도 함께 고정한다. 조용히 fail-close 하면
    // auth의 DB 오류가 전 요청 401로 나타나면서 아무 진단도 남지 않는다.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await withApp({ validateUser: async () => { throw new Error('db is down'); } }, async (client) => {
        const res = await client.get('/api/admin', { cookie });
        assert.equal(res.status, 401, 'a throwing validator must fail closed, not 500');
        assert.equal(res.headers.get('set-cookie'), null, 'a transient failure must not clear the session');
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((w) => w.includes('fail-close') && w.includes('u@test.com') && w.includes('db is down')),
      `a thrown validator error must be logged, got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ─── Required-secret boot guards ──────────────────────────────────────────
// INTERNAL_SECRET을 재검증 조건에서 빼면서 이 가드가 그 시크릿의 유일한 방어선이 됐다.
// 프로덕션 exit 분기를 통째로 지워도 전 스위트가 통과하므로, 자식 프로세스로 직접 고정한다.
describe('INTERNAL_SECRET boot guard', () => {
  // 부모 env를 상속한다(PATH·HOME 없이는 자식 node가 뜨지 않는다). 검사 대상 변수만 조작.
  async function boot({ nodeEnv, internalSecret }) {
    const { spawnSync } = await import('node:child_process');
    // `-e` 스크립트는 파일 URL 기준이 없어 상대 동적 import가 cwd로 해석된다. 절대 URL을
    // 넘기지 않으면 MODULE_NOT_FOUND도 exit 1이라 가드를 안 타고도 통과해 버린다.
    const setupUrl = new URL('../../shared/express-setup.mjs', import.meta.url).href;
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire('${import.meta.url}');
      const express = require('../../auth/node_modules/express');
      const { createApp } = await import('${setupUrl}');
      createApp({ express }, () => null);
      console.log('BOOTED');
    `;
    const env = { ...process.env, NODE_ENV: nodeEnv, JWT_SECRET: TEST_SECRET };
    if (internalSecret) env.INTERNAL_SECRET = internalSecret;
    else delete env.INTERNAL_SECRET;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('aborts a production boot when INTERNAL_SECRET is missing', async () => {
    const { code, stdout, stderr } = await boot({ nodeEnv: 'production' });
    assert.equal(code, 1, 'production must not boot without INTERNAL_SECRET');
    assert.doesNotMatch(stdout, /BOOTED/);
    assert.match(stderr, /INTERNAL_SECRET must be set in production/);
  });

  it('boots with a warning outside production', async () => {
    const { code, stdout, stderr } = await boot({ nodeEnv: 'development' });
    assert.equal(code, 0, 'non-production still boots');
    assert.match(stdout, /BOOTED/);
    assert.match(stderr, /INTERNAL_SECRET is not set/);
  });

  it('boots silently when the secret is present', async () => {
    const { code, stderr } = await boot({ nodeEnv: 'production', internalSecret: TEST_INTERNAL_SECRET });
    assert.equal(code, 0);
    assert.doesNotMatch(stderr, /INTERNAL_SECRET/);
  });
});
