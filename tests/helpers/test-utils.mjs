import { createJWT } from '../../shared/express-setup.mjs';
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
