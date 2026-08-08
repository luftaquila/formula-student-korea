import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../../auth/node_modules/better-sqlite3');

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { createTeamStateClient } from '../../shared/team-state-client.mjs';

const YEAR = 2031;

// 가짜 entry: /api/internal/team-state 스냅샷 + /api/events SSE
function startFakeEntry() {
  const state = {
    snapshots: new Map(), // year -> snapshot
    failNext: false,
    requests: 0,
    sseClients: new Set(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/internal/team-state') {
      state.requests++;
      if (state.failNext) {
        res.writeHead(500);
        return res.end('boom');
      }
      const y = Number(url.searchParams.get('year'));
      const snap = state.snapshots.get(y) || { year: y, version: 0, teams: {}, tombstones: [] };
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(snap));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      state.sseClients.add(res);
      req.on('close', () => state.sseClients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, state,
        url: `http://127.0.0.1:${server.address().port}`,
        broadcastEntries(payload) {
          for (const res of state.sseClients) {
            res.write(`event: entries\ndata: ${JSON.stringify(payload)}\n\n`);
          }
        },
      });
    });
  });
}

function snapshotOf(version, teams, tombstones = []) {
  return { year: YEAR, version, teams, tombstones };
}

const TEAMS_V1 = {
  101: { num: 1, univ: 'U1', team: 'T1', type: null, active: true },
  102: { num: 2, univ: 'U2', team: 'T2', type: 'E-Formula', active: false },
};

function waitFor(checkFn, timeoutMs = 3000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (checkFn()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')); }
    }, intervalMs);
  });
}

describe('createTeamStateClient', () => {
  let fake, db, client;

  beforeEach(async () => {
    fake = await startFakeEntry();
    db = new Database(':memory:');
  });

  afterEach(async () => {
    client?.stop();
    db.close();
    await new Promise((r) => fake.server.close(r));
  });

  function makeClient(opts = {}) {
    client = createTeamStateClient({
      db, service: 'testsvc', entryUrl: fake.url, ttlMs: opts.ttlMs ?? 30_000, ...opts,
    });
    return client;
  }

  it('fetches, indexes by id and num, and lists inactive nums', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(3, TEAMS_V1));
    const c = makeClient();
    const state = await c.getState(YEAR);
    assert.equal(state.loaded, true);
    assert.equal(state.version, 3);
    assert.deepEqual(state.teams.get(101).team, 'T1');
    assert.equal(state.byNum.get(2).id, 102);
    assert.deepEqual(state.inactiveNums, [2]);
    assert.equal(state.inactiveNumsJson, '[2]');
    assert.equal(c.resolveTeamId(YEAR, 1), 101);
    assert.equal(c.isActive(YEAR, 1), true);
    assert.equal(c.isActive(YEAR, 2), false);
    assert.equal(c.isActive(YEAR, 99), true, 'unknown team = active');
  });

  it('serves the cache within the TTL and refetches after expiry', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const c = makeClient({ ttlMs: 50 });
    await c.getState(YEAR);
    await c.getState(YEAR);
    assert.equal(fake.state.requests, 1, 'second call within TTL must hit the cache');
    await new Promise((r) => setTimeout(r, 60));
    await c.getState(YEAR);
    assert.equal(fake.state.requests, 2, 'TTL expiry must refetch');
  });

  it('serves stale state when the fetch fails', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const c = makeClient({ ttlMs: 1 });
    const first = await c.getState(YEAR);
    assert.equal(first.loaded, true);
    fake.state.failNext = true;
    await new Promise((r) => setTimeout(r, 5));
    const second = await c.getState(YEAR);
    assert.equal(second.loaded, true, 'stale state must be served on failure');
    assert.equal(second.version, 1);
  });

  it('empty cache semantics: loaded=false, everyone active, resolveTeamId null', () => {
    const c = makeClient();
    const state = c.getStateSync(YEAR);
    assert.equal(state.loaded, false);
    assert.equal(c.isActive(YEAR, 1), true);
    assert.equal(c.resolveTeamId(YEAR, 1), null);
  });

  it('restores from the checkpoint on cold start (second client, entry down)', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(2, TEAMS_V1));
    const c1 = makeClient();
    await c1.getState(YEAR);
    c1.stop();

    // 같은 DB로 새 클라이언트 (프로세스 재시작 흉내), entry는 전부 실패
    fake.state.failNext = true;
    const c2 = createTeamStateClient({ db, service: 'testsvc', entryUrl: 'http://127.0.0.1:1', ttlMs: 30_000 });
    const state = c2.getStateSync(YEAR);
    assert.equal(state.loaded, true, 'checkpoint must restore the last snapshot');
    assert.equal(state.version, 2);
    assert.equal(c2.isActive(YEAR, 2), false, 'inactive team stays inactive from the checkpoint');
    c2.stop();
    client = c1; // afterEach cleanup 대상 지정
  });

  it('runs backfill exactly once, with the flag in the same transaction', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const calls = [];
    const c = makeClient();
    c.registerBackfill((year, state) => calls.push([year, state.teams.size]));
    await c.getState(YEAR);
    fake.state.snapshots.set(YEAR, snapshotOf(2, TEAMS_V1));
    await c.refresh(YEAR);
    assert.deepEqual(calls, [[YEAR, 2]], 'backfill must run once');
    assert.ok(db.prepare('SELECT 1 FROM team_id_backfill WHERE year = ?').get(YEAR));
  });

  it('does NOT mark backfill done on an empty snapshot', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(0, {}));
    const calls = [];
    const c = makeClient({ ttlMs: 1 });
    c.registerBackfill((year) => calls.push(year));
    await c.getState(YEAR);
    assert.deepEqual(calls, []);
    assert.equal(db.prepare('SELECT 1 FROM team_id_backfill WHERE year = ?').get(YEAR), undefined);
    // 팀이 생기면 그때 백필
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    await new Promise((r) => setTimeout(r, 5));
    await c.getState(YEAR);
    assert.deepEqual(calls, [YEAR]);
  });

  it('does not re-run backfill on checkpoint restore', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const calls = [];
    const c1 = makeClient();
    c1.registerBackfill(() => calls.push('run'));
    await c1.getState(YEAR);
    c1.stop();

    const c2 = createTeamStateClient({ db, service: 'testsvc', entryUrl: 'http://127.0.0.1:1' });
    c2.registerBackfill(() => calls.push('run'));
    c2.getStateSync(YEAR); // 체크포인트 복원
    assert.deepEqual(calls, ['run']);
    c2.stop();
    client = c1;
  });

  it('runs enforcement only when the version changes, and post-commit callbacks fire', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const runs = [];
    const broadcasts = [];
    const c = makeClient({ ttlMs: 1 });
    c.registerEnforcement((year, state) => {
      runs.push(state.version);
      return () => broadcasts.push(state.version);
    });
    await c.getState(YEAR);
    await new Promise((r) => setTimeout(r, 5));
    await c.getState(YEAR); // 같은 version 재조회 → 강제 없음
    assert.deepEqual(runs, [1]);

    fake.state.snapshots.set(YEAR, snapshotOf(2, TEAMS_V1));
    await new Promise((r) => setTimeout(r, 5));
    await c.getState(YEAR);
    assert.deepEqual(runs, [1, 2]);
    await waitFor(() => broadcasts.length === 2);
    assert.deepEqual(broadcasts, [1, 2]);
  });

  it('does not re-run enforcement on checkpoint restore with an unchanged version', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const runs = [];
    const c1 = makeClient();
    c1.registerEnforcement(() => runs.push('run'));
    await c1.getState(YEAR);
    c1.stop();

    const c2 = createTeamStateClient({ db, service: 'testsvc', entryUrl: 'http://127.0.0.1:1' });
    c2.registerEnforcement(() => runs.push('run'));
    c2.getStateSync(YEAR);
    assert.deepEqual(runs, ['run'], 'restore with applied version must not re-enforce');
    c2.stop();
    client = c1;
  });

  it('an entries SSE event triggers a refresh; already-applied versions are skipped', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const c = makeClient();
    await c.getState(YEAR);

    c.start();
    await waitFor(() => fake.state.sseClients.size === 1);
    // start()의 부팅 fetch(체크포인트 연도 + 현재 연도)가 가라앉은 뒤를 기준점으로
    await new Promise((r) => setTimeout(r, 50));
    const before = fake.state.requests;

    // 이미 반영된 version → 재조회 생략
    fake.broadcastEntries({ year: YEAR, change: 'noop', version: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.state.requests, before, 'same-version event must not refetch');

    // 새 version → 재조회
    fake.state.snapshots.set(YEAR, snapshotOf(2, TEAMS_V1));
    fake.broadcastEntries({ year: YEAR, change: 'update', version: 2 });
    await waitFor(() => fake.state.requests > before);
    await waitFor(() => c.getStateSync(YEAR).version === 2);
  });

  it('getStateSync triggers a background refresh when stale', async () => {
    fake.state.snapshots.set(YEAR, snapshotOf(1, TEAMS_V1));
    const c = makeClient({ ttlMs: 10 });
    await c.getState(YEAR);
    fake.state.snapshots.set(YEAR, snapshotOf(2, TEAMS_V1));
    await new Promise((r) => setTimeout(r, 20));
    const stale = c.getStateSync(YEAR); // 즉시 stale 반환 + 백그라운드 갱신
    assert.equal(stale.version, 1);
    await waitFor(() => c.getStateSync(YEAR).version === 2);
  });
});
