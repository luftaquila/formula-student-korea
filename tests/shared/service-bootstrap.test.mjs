import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');
const Database = require('../../auth/node_modules/better-sqlite3');

import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TRUST_JWT,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createServiceSkeleton, addSpaFallback, runIfDirect } from '../../shared/service-bootstrap.mjs';
import { servicePort, SERVICE_NAMES } from '../../shared/services.mjs';

describe('createServiceSkeleton', () => {
  const dbPath = tmpDbPath();
  after(() => cleanup(dbPath));

  it('wires db, logger, /api/health, /api/logs and dbRun', async () => {
    const { app, db, logger, dbRun } = createServiceSkeleton({
      name: 'skeltest', express, Database,
      options: { dbPath, validateUser: TRUST_JWT },
      authRoleFn: (req) => (req.path === '/api/health' ? null : 'admin'),
    });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='logs'").get(), 'logs table created');
    logger.log(null, 'skel.test', null);
    assert.equal(dbRun(() => 42).result, 42);

    const { server, baseUrl } = await startServer(app);
    try {
      const client = createClient(baseUrl);
      const health = await client.get('/api/health');
      assert.equal(await health.text(), 'ok');

      const adminCookie = makeAuthCookie({ email: 'a@t.co', name: 'A', role: 'admin' });
      const logsRes = await client.get('/api/logs', { cookie: adminCookie });
      assert.equal(logsRes.status, 200);
      const data = await logsRes.json();
      assert.equal(data.service, 'skeltest');
      assert.ok(data.logs.some((l) => l.action === 'skel.test'));

      const denied = await client.get('/api/logs', {
        cookie: makeAuthCookie({ email: 's@t.co', name: 'S', role: 'student' }),
      });
      assert.equal(denied.status, 403, '/api/logs stays admin-gated');
    } finally {
      await stopServer(server);
    }
    db.close();
  });

  it('defaults the db file to ./data/<name>.db and honors dbFile override', () => {
    fs.mkdirSync('./data', { recursive: true });
    const a = createServiceSkeleton({
      name: 'skelfile', express, Database, options: { validateUser: TRUST_JWT },
    });
    a.db.close();
    assert.ok(fs.existsSync('./data/skelfile.db'));

    const b = createServiceSkeleton({
      name: 'skelfile', express, Database, options: { validateUser: TRUST_JWT }, dbFile: 'other.db',
    });
    b.db.close();
    assert.ok(fs.existsSync('./data/other.db'));
    cleanup('./data/skelfile.db', './data/other.db');
  });
});

describe('addSpaFallback', () => {
  it('registers a catch-all that serves index.html', async () => {
    // 공유 ./web/dist 대신 스위트 전용 임시 루트 — 병렬 파일의 픽스처/teardown과 충돌 방지.
    // sendFile은 절대 경로 root를 요구하므로 mkdtemp 결과를 그대로 쓴다.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsk-spa-test-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html>spa</html>');
    try {
      const app = express();
      addSpaFallback(app, root);
      const { server, baseUrl } = await startServer(app);
      try {
        const res = await fetch(`${baseUrl}/some/deep/route`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '<html>spa</html>');
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runIfDirect', () => {
  it('no-ops when the module is not the entrypoint', () => {
    let called = false;
    runIfDirect({ filename: '/definitely/not/argv1.mjs' }, 'auth', () => {
      called = true;
      return { app: null, db: null };
    });
    assert.equal(called, false);
  });
});

describe('servicePort', () => {
  it('matches the ports declared in compose.yml (registry drift guard)', () => {
    const compose = fs.readFileSync('./compose.yml', 'utf8');
    // 파일 전체 검색은 "포트가 어딘가에 존재"만 증명해 서비스 간 포트 스왑을 못 잡는다.
    // services: 아래의 해당 서비스 블록(2칸 들여쓰기 키 ~ 다음 2칸 들여쓰기 키)만 잘라
    // 그 안에서 PORT 빌드 인자 또는 헬스체크 포트를 확인한다.
    const servicesSection = compose.slice(compose.indexOf('\nservices:\n') + 1);
    function composeBlock(name) {
      const m = servicesSection.match(new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, 'm'));
      assert.ok(m, `compose.yml must define a '${name}' service`);
      return m[1];
    }
    for (const name of SERVICE_NAMES) {
      const port = servicePort(name);
      const block = composeBlock(name);
      // 빌드 PORT와 헬스체크 포트는 독립적으로 드리프트할 수 있다(예: 헬스체크만 다른
      // 포트로 바뀌면 컨테이너가 unhealthy) — 둘 다 각각 요구한다.
      assert.ok(
        block.includes(`PORT: ${port}`),
        `compose.yml service '${name}' should declare build arg PORT: ${port}`,
      );
      assert.ok(
        block.includes(`:${port}/api/health`),
        `compose.yml service '${name}' healthcheck should probe port ${port}`,
      );
    }
  });

  it('throws on unknown service names', () => {
    assert.throws(() => servicePort('nope'));
  });
});
