import { createJWT } from '../../shared/express-setup.mjs';
import http from 'http';
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

// 가짜 entry 서버: team-state 스냅샷 + entries SSE. 다운스트림 서비스의 team-state
// 동기화(백필·수렴형 강제) 테스트가 공유한다.
//   const fake = await startFakeEntryServer();
//   fake.setSnapshot(2031, { version: 1, teams: { 101: { num: 1, univ, team, type, active } }, tombstones: [] });
//   process.env.ENTRY_SERVER = fake.url;  // 팩토리 생성 전에
//   ... 서비스의 teamState.refresh(year)로 반영 유도 ...
//   await fake.close();
export function startFakeEntryServer() {
  const snapshots = new Map();
  const sseClients = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/internal/team-state') {
      const y = Number(url.searchParams.get('year'));
      const snap = snapshots.get(y) || { year: y, version: 0, teams: {}, tombstones: [] };
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ year: y, ...snap }));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // 그 외(GET /api/entries 등)는 404 — team-state 이행 후 아무도 부르지 않아야 한다
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        setSnapshot(year, snap) { snapshots.set(Number(year), snap); },
        getSnapshot(year) { return snapshots.get(Number(year)); },
        broadcastEntries(payload) {
          for (const res of sseClients) res.write(`event: entries\ndata: ${JSON.stringify(payload)}\n\n`);
        },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}

// 대부분의 테스트는 auth 서비스 없이 대상 서비스만 띄우므로 재검증할 상대가 없다.
// 앱 팩토리에 `validateUser: TRUST_JWT`로 주입해 JWT를 그대로 신뢰시킨다. `role: null`은
// "역할 변경 없음"이라 미들웨어가 JWT의 role을 유지한다.
//
// 런타임 스위치(env) 대신 주입인 이유: 프로덕션에 재검증을 끌 수단 자체를 만들지 않기
// 위해서다. mock auth를 세우는 테스트는 이걸 넘기지 말고 AUTH_SERVER만 지정하면
// 실제 HTTP 재검증 경로를 그대로 탄다.
export const TRUST_JWT = async () => ({ valid: true, role: null });
