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

  app.get('/api/internal/team-status', async (req, res) => {
    if (api.delayGetMs) await new Promise((r) => setTimeout(r, api.delayGetMs));
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

  const api = { app, state, applied, delayGetMs: 0 };
  return api;
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

  // 미러가 앞선 리비전을 들고 있으면(entry DB만 복원했을 때 생기는 상태) 같은 리비전으로
  // 재전송해봐야 downstream 가드가 200으로 무시하고 outbox 행만 지워진다. 매번 고쳤다고
  // 보고하면서 영원히 안 고쳐지던 경로다.
  it('raises the revision when the mirror is ahead, so the repair actually applies', async () => {
    mirror.state.set(11, { active: false, revision: 999 });   // entry는 11을 active로 안다
    mirror.applied.length = 0;

    const summary = await reconcile();

    assert.equal(mirror.state.get(11).active, true, 'the mirror must actually converge');
    assert.ok(mirror.applied.some((a) => a.num === 11 && a.revision > 999),
      `re-send must carry a revision above the mirror's, got ${JSON.stringify(mirror.applied)}`);
    assert.ok(summary.repaired >= 1);

    // 두 번째 실행은 조용해야 한다. 안 그러면 매번 "고쳤다"고 보고하는 예전 동작이다.
    mirror.applied.length = 0;
    const second = await reconcile();
    assert.deepEqual(mirror.applied, [], 'a converged mirror is not rewritten');
    assert.equal(second.repaired, 0);
  });

  it('persists the raised revision on the entry row', async () => {
    mirror.state.set(11, { active: false, revision: 5000 });
    mirror.applied.length = 0;
    await reconcile();

    const row = db.prepare(`SELECT active_revision FROM 'entry_${YEAR}' WHERE num = 11`).get();
    assert.ok(row.active_revision > 5000, 'entry must keep the revision it issued');
    assert.equal(row.active_revision, mirror.state.get(11).revision,
      'or the next real event for this team is rejected too');
  });

  // 부팅 훅은 30초 재시도 타이머보다 먼저 돈다. 아직 배달 안 된 이벤트를 drift로 오인하면
  // 재시작마다 가짜 경고와 중복 이벤트가 쌓인다.
  it('does not report in-flight events as drift', async () => {
    db.prepare('DELETE FROM lifecycle_outbox').run();
    const num = 10;
    const cur = db.prepare(`SELECT active, active_revision FROM 'entry_${YEAR}' WHERE num = ?`).get(num);
    db.prepare(`
      INSERT INTO lifecycle_outbox (event_type, service, method, path, body, next_attempt_at)
      VALUES ('team.active', 'inspection', 'PATCH', '/api/internal/team-active', ?, ?)
    `).run(JSON.stringify({ num, year: YEAR, active: !cur.active, revision: cur.active_revision + 1 }), Date.now() + 600000);
    // 미러를 어긋나게 해두되, 그 번호엔 배달 대기 행이 있다.
    mirror.state.set(num, { active: !cur.active, revision: cur.active_revision });
    mirror.applied.length = 0;

    const events = db.prepare("SELECT COUNT(*) c FROM lifecycle_outbox").get().c;
    await reconcile();

    // 대기 행은 inspection 것뿐이므로 inspection만 건너뛰고, 나머지 셋은 정상 복구된다.
    // 전체를 막으면 queue 하나가 막혔을 때 다른 서비스 복구까지 그 행이 dead 될 때까지 멈춘다.
    const inspectionEvents = db.prepare(
      "SELECT COUNT(*) c FROM lifecycle_outbox WHERE service='inspection'").get().c;
    assert.equal(inspectionEvents, 1, 'no duplicate event was queued for the blocked service');
    assert.ok(events >= 1);
    db.prepare('DELETE FROM lifecycle_outbox').run();
  });

  it('reports unknown teams in the summary, not only in the log', async () => {
    mirror.state.set(777, { active: true, revision: 1 });
    const summary = await reconcile();
    assert.ok(summary.unknown.some((u) => u.nums.includes(777)),
      'the one item needing a human must be visible to the caller');
    mirror.state.delete(777);
  });

  it('does not repeat a service in unreachable', async () => {
    const prev = process.env.SCORE_SERVER;
    process.env.SCORE_SERVER = 'http://127.0.0.1:1';
    try {
      const summary = await reconcile();
      assert.deepEqual(summary.unreachable.filter((s) => s === 'score'), ['score']);
    } finally {
      process.env.SCORE_SERVER = prev;
    }
  });

  it('requires admin', async () => {
    const res = await client.post('/api/admin/reconcile', {
      cookie: makeAuthCookie({ email: 's@test.com', name: 'S', role: 'student' }),
    });
    assert.equal(res.status, 403);
  });
});

// 리비전 상향은 미러가 들고 있던 값을 entry의 전역 카운터 산술에 그대로 밀어 넣는다.
// 손상·수동 조작 DB에서 정수가 아닌 값이 오면 카운터가 붕괴하고, 그 뒤로 모든 team.active가
// 미러보다 낮은 리비전을 달고 나가 전부 조용히 거부된다 — 이 기능이 막으려던 사고 그 자체.
describe('reconcile hardening', () => {
  let db, dbPath, stop, reconcile, client, server, mirror, mirrorServer;

  before(async () => {
    mirror = createMirrorService();
    const started = await startServer(mirror.app);
    mirrorServer = started.server;
    for (const key of LIFECYCLE_ENVS) process.env[key] = started.baseUrl;

    dbPath = tmpDbPath();
    const result = createEntryApp({ dbPath, validateUser: TRUST_JWT, skipReconcileOnBoot: true });
    db = result.db;
    reconcile = result.reconcileTeamStatus;
    stop = result.stopLifecycleOutboxRetry;
    const app = await startServer(result.app);
    server = app.server;
    client = createClient(app.baseUrl);
    await client.post('/api/entries', { body: { num: 40, univ: 'U40', team: 'T40' }, cookie: adminCookie });
  });

  after(async () => {
    stop?.();
    await stopServer(server);
    await stopServer(mirrorServer);
    for (const key of LIFECYCLE_ENVS) delete process.env[key];
    db.close();
    cleanup(dbPath);
  });

  // 상향은 미러 값을 entry 전역 카운터의 산술(`MAX(value, ?) + 1`)에 그대로 넣는다. SQLite는
  // TEXT를 INTEGER보다 크게 보므로 `MAX(500, '') + 1`은 500이 아니라 1이 된다 — 카운터가
  // 붕괴하면 이후 모든 team.active가 미러보다 낮은 리비전을 달고 나가 전부 조용히 거부된다.
  // 즉 이 기능이 막으려던 사고를 이 기능이 일으킨다.
  //
  // 순수 'abc'는 JS 비교(`mirrorRevision >= revision`)에서 걸러진다. 실제로 통과하는 조합은
  // 빈 문자열과 리비전 0인 팀이다(`'' >= 0`은 true) — 활성 기능 이전에 만들어진 행이 그렇다.
  it('does not let a corrupt mirror revision collapse entry\'s counter', async () => {
    // 카운터를 충분히 올려둬야 1로 붕괴하는 것과 정상 증가가 구분된다.
    db.prepare('UPDATE entry_active_revision SET value = 5000 WHERE id = 1').run();
    db.prepare(`UPDATE 'entry_${YEAR}' SET active_revision = 0 WHERE num = 40`).run();
    const before = db.prepare('SELECT value FROM entry_active_revision WHERE id = 1').get().value;
    mirror.state.set(40, { active: false, revision: '' });
    mirror.applied.length = 0;

    await reconcile();

    const after = db.prepare('SELECT value FROM entry_active_revision WHERE id = 1').get().value;
    assert.ok(after >= before, `counter must not collapse: ${before} -> ${after}`);
    assert.ok(mirror.applied.some((a) => a.num === 40 && Number.isInteger(a.revision) && a.revision > 0),
      'the re-send must still carry a usable integer revision');
  });

  // truth는 스냅샷 fetch 전에 읽힌다. 그 사이 관리자가 상태를 바꾸면, 상향된 리비전이 그
  // 변경을 이기고 다운스트림에서 되돌려 버린다 — 낡은 읽기가 권위 있는 쓰기로 승격되는 것.
  it('skips a team whose state changed after the diff was taken', async () => {
    mirror.state.set(40, { active: false, revision: 9000 });
    mirror.delayGetMs = 300;
    mirror.applied.length = 0;
    try {
      const pass = reconcile();
      await new Promise((r) => setTimeout(r, 80));
      await client.patch('/api/entries/40/active', { body: { active: false }, cookie: adminCookie });
      await pass;
    } finally {
      mirror.delayGetMs = 0;
    }

    const row = db.prepare(`SELECT active FROM 'entry_${YEAR}' WHERE num = 40`).get();
    assert.equal(!!row.active, false, 'the admin change stands');
    const revived = mirror.applied.filter((a) => a.num === 40 && a.active === true);
    assert.deepEqual(revived, [], 'reconcile must not push the stale active=true it diffed against');
  });

  it('rejects a concurrent reconcile instead of opening a second stale window', async () => {
    mirror.delayGetMs = 200;
    try {
      const first = client.post('/api/admin/reconcile', { cookie: adminCookie });
      await new Promise((r) => setTimeout(r, 40));
      const second = await client.post('/api/admin/reconcile', { cookie: adminCookie });
      assert.equal(second.status, 409);
      assert.equal((await first).status, 200);
    } finally {
      mirror.delayGetMs = 0;
    }
  });
});
