import { createJWT } from '../../shared/express-setup.mjs';
import { expandPermissions } from '../../shared/access-control.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const TEST_SECRET = 'test-jwt-secret-key';
export const TEST_INTERNAL_SECRET = 'test-internal-secret';

export function tmpDbPath() {
  return path.join(os.tmpdir(), `fsk-test-${crypto.randomUUID()}.db`);
}

export function makeAuthCookie(user, secret = TEST_SECRET) {
  const jwt = createJWT(user, secret);
  return `fsk_session=${jwt}`;
}

export function createClient(baseUrl) {
  async function req(method, urlPath, { body, cookie, headers } = {}) {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (cookie) opts.headers['Cookie'] = cookie;
    return fetch(`${baseUrl}${urlPath}`, opts);
  }
  return {
    get: (p, opts) => req('GET', p, opts || {}),
    post: (p, opts) => req('POST', p, opts || {}),
    put: (p, opts) => req('PUT', p, opts || {}),
    patch: (p, opts) => req('PATCH', p, opts || {}),
    delete: (p, opts) => req('DELETE', p, opts || {}),
  };
}

export function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

export function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '-wal'); } catch {}
    try { fs.unlinkSync(p + '-shm'); } catch {}
  }
}

export function setupTestEnv() {
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.INTERNAL_SECRET = TEST_INTERNAL_SECRET;
}

// 대부분의 테스트는 auth 서비스 없이 대상 서비스만 띄우므로 재검증할 상대가 없다.
// 앱 팩토리에 `validateUser: TRUST_JWT`로 주입해 JWT를 그대로 신뢰시킨다. `role: null`은
// "역할 변경 없음"이라 미들웨어가 JWT의 role을 유지한다.
//
// 런타임 스위치(env) 대신 주입인 이유: 프로덕션에 재검증을 끌 수단 자체를 만들지 않기
// 위해서다. mock auth를 세우는 테스트는 이걸 넘기지 말고 AUTH_SERVER만 지정하면
// 실제 HTTP 재검증 경로를 그대로 탄다.
const LEGACY_TEST_PERMISSIONS = Object.freeze({
  student: [],
  staff: ["registration.operate"],
  official: ["registration.operate", "queue.operate", "inspection.operate"],
  chief: ["registration.manage", "queue.manage", "inspection.manage", "documents.manage", "calendar.manage"],
  master: [
    "registration.manage", "queue.manage", "inspection.manage", "documents.manage", "calendar.manage",
    "course.operate", "traffic.manage", "score.manage",
  ],
  admin: [],
});

// Legacy role-shaped fixtures remain useful to keep the service behavior suites
// focused on their domain. Normalize them at the injected auth boundary; new
// authorization tests pass an explicit Official permission list.
export const TRUST_JWT = async (email, tokenUser = {}) => ({
  valid: true,
  role: ["staff", "chief", "master"].includes(tokenUser.role) ? "official" : tokenUser.role,
  realname: tokenUser.realname ?? tokenUser.name ?? "",
  permissions: expandPermissions(Array.isArray(tokenUser.permissions)
    ? tokenUser.permissions
    : LEGACY_TEST_PERMISSIONS[tokenUser.role] || []),
  accessRevision: Number(tokenUser.accessRevision) || 0,
});
