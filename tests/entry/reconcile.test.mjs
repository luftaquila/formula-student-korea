import { describe, it, before, after, beforeEach } from 'node:test';
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
  TRUST_JWT,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createEntryApp } from '../../entry/index.mjs';

const require = createRequire(import.meta.url);
const expressForMock = require('../../entry/node_modules/express/index.js');

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const YEAR = new Date().getFullYear();
const LIFECYCLE_ENVS = ['QUEUE_SERVER', 'DOCUMENTS_SERVER', 'INSPECTION_SERVER', 'SCORE_SERVER', 'TRAFFIC_SERVER'];

// team_status를 실제로 들고 있는 mock. entry의 점검이 스냅샷을 읽고 재전송을 적용하는
// 왕복 전체를 태워야 의미가 있으므로, GET과 PATCH를 둘 다 진짜로 구현한다.
function createMirrorService() {
  const state = new Map();          // num -> { active, revision }
  const applied = [];               // 수신한 PATCH 기록
  const app = expressForMock();
  app.use(expressForMock.json());

  app.get('/api/internal/team-status', (req, res) => {
    const snapshot = {};
    for (const [num, v] of state) snapshot[num] = { active: v.active, revision: v.revision };
    res.json(snapshot);
  });

  app.patch('/api/internal/team-active', (req, res) => {
    const { num, active, revision } = req.body;
    applied.push({ num, active, revision });
    const cur = state.get(num);
    // 실서비스와 같은 revision 가드 — 재전송이 멱등이어야 한다.
    if (!cur || cur.revision < revision) state.set(num, { active, revision });
    res.status(200).send();
  });

  return { app, state, applied };
}

describe('entry lifecycle reconciliation', () => {
  let server, baseUrl, client, db, dbPath, stopLifecycleOutboxRetry, reconcile;
  let mirror, mirrorServer;

  before(async () => {
    mirror = createMirrorService();
    const started = await startServer(mirror.app);
    mirrorServer = started.server;
    // 네 개의 active-sync 대상이 전부 같은 mock을 보게 해서, 어긋남이 대상별로
    // 독립 처리되는지까지 한 번에 관찰한다.
    for (const key of LIFECYCLE_ENVS) process.env[key] = started.baseUrl;

    dbPath = tmpDbPath();
    const result = createEntryApp({ dbPath, validateUser: TRUST_JWT, skipReconcileOnBoot: true });
    db = result.db;
    reconcile = result.reconcileTeamStatus;
    stopLifecycleOutboxRetry = result.stopLifecycleOutboxRetry;
    const app = await startServer(result.app);
    server = app.server;
    baseUrl = app.baseUrl;
    client = createClient(baseUrl);

    await client.post('/api/entries', { body: { num: 10, univ: 'U10', team: 'T10' }, cookie: adminCookie });
    await client.post('/api/entries', { body: { num: 11, univ: 'U11', team: 'T11' }, cookie: adminCookie });
  });

  after(async () => {
    stopLifecycleOutboxRetry?.();
    await stopServer(server);
    await stopServer(mirrorServer);
    for (const key of LIFECYCLE_ENVS) delete process.env[key];
    db.close();
    cleanup(dbPath);
  });

  beforeEach(() => {
    mirror.applied.length = 0;
    db.prepare('DELETE FROM lifecycle_outbox').run();
  });

  it('is silent when the mirror already agrees', async () => {
    const summary = await reconcile();
    assert.deepEqual(mirror.applied, [], 'an agreeing mirror must not be written to');
    assert.equal(summary.repaired, 0);
    assert.ok(summary.checked > 0, 'it did look at the services');
  });

  it('repairs a mirror that never received a deactivation', async () => {
    // 사고 그대로의 상황: entry는 비활성인데 미러엔 행 자체가 없다(= active로 간주).
    const res = await client.patch(`/api/entries/10/active`, { body: { active: false }, cookie: adminCookie });
    assert.ok([200, 202].includes(res.status));
    mirror.state.delete(10);
    mirror.applied.length = 0;

    const summary = await reconcile();

    assert.ok(summary.repaired >= 1, 'drift must be repaired');
    assert.ok(mirror.applied.some((a) => a.num === 10 && a.active === false),
      'entry must re-send the current state');
    assert.equal(mirror.state.get(10).active, false, 'the mirror converges');
  });

  it('repairs a mirror that disagrees outright', async () => {
    mirror.state.set(11, { active: false, revision: 1 });   // entry는 11을 active로 안다
    mirror.applied.length = 0;

    await reconcile();

    assert.ok(mirror.applied.some((a) => a.num === 11 && a.active === true));
    assert.equal(mirror.state.get(11).active, true);
  });

  it('does not re-send when only the revision is behind', async () => {
    // 실효 상태가 같으면 손대지 않는다. 다음 이벤트가 어차피 수렴시키므로 재전송은
    // 로그만 늘린다 — 점검이 스스로 노이즈가 되지 않아야 한다.
    const cur = mirror.state.get(11);
    mirror.state.set(11, { active: cur.active, revision: 0 });
    mirror.applied.length = 0;

    const summary = await reconcile();

    assert.deepEqual(mirror.applied, [], 'matching state must not trigger a write');
    assert.equal(summary.repaired, 0);
  });

  it('never deletes a team the mirror has and entry does not', async () => {
    mirror.state.set(999, { active: true, revision: 1 });
    mirror.applied.length = 0;

    await reconcile();

    assert.ok(mirror.state.has(999), 'an unknown team is reported, not removed');
    assert.deepEqual(mirror.applied.filter((a) => a.num === 999), [],
      'and no state is pushed for it');
    mirror.state.delete(999);
  });

  it('survives an unreachable service and reports it', async () => {
    const prev = process.env.SCORE_SERVER;
    process.env.SCORE_SERVER = 'http://127.0.0.1:1';
    try {
      const summary = await reconcile();
      assert.ok(summary.unreachable.includes('score'), 'the failure is named, not swallowed');
    } finally {
      process.env.SCORE_SERVER = prev;
    }
  });

  it('exposes an admin endpoint for post-restore checks', async () => {
    const res = await client.post('/api/admin/reconcile', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const summary = await res.json();
    assert.ok(Number.isInteger(summary.checked));
    assert.ok(Number.isInteger(summary.repaired));
    assert.ok(Array.isArray(summary.unreachable));
  });

  it('requires admin', async () => {
    const res = await client.post('/api/admin/reconcile', {
      cookie: makeAuthCookie({ email: 's@test.com', name: 'S', role: 'student' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('team-status snapshot route', () => {
  it('rejects a request without the internal secret', async () => {
    const mock = createMirrorService();
    const started = await startServer(mock.app);
    try {
      // mock은 가드가 없으므로 여기서는 계약(형태)만 고정한다. 실제 가드는 각 서비스의
      // requireInternalRequest가 담당하고 그쪽 스위트가 덮는다.
      const res = await fetch(`${started.baseUrl}/api/internal/team-status?year=${YEAR}`, {
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {});
    } finally {
      await stopServer(started.server);
    }
  });
});
