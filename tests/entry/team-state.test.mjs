import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const YEAR = 2031; // 다른 스위트와 격리된 과거/미래 연도

let server, baseUrl, client, db, dbPath, stopLifecycleOutboxRetry;
let lifecycleSink;

before(async () => {
  // 아웃박스 팬아웃이 컨테이너 DNS로 나가지 않도록 전부 200 sink로 (entry.test.mjs와 동일 패턴)
  lifecycleSink = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.end();
  });
  await new Promise((resolve) => lifecycleSink.listen(0, '127.0.0.1', resolve));
  const sinkUrl = `http://127.0.0.1:${lifecycleSink.address().port}`;
  for (const key of ['QUEUE_SERVER', 'DOCUMENTS_SERVER', 'INSPECTION_SERVER', 'SCORE_SERVER', 'TRAFFIC_SERVER']) {
    process.env[key] = sinkUrl;
  }

  dbPath = tmpDbPath();
  const result = createEntryApp({ dbPath, validateUser: TRUST_JWT, skipReconcileOnBoot: true });
  db = result.db;
  stopLifecycleOutboxRetry = result.stopLifecycleOutboxRetry;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  stopLifecycleOutboxRetry?.();
  await stopServer(server);
  await new Promise((resolve) => lifecycleSink.close(resolve));
  db.close();
  cleanup(dbPath);
});

beforeEach(async () => {
  await client.delete(`/api/entries?year=${YEAR}`, { cookie: adminCookie });
  db.prepare('DELETE FROM team_tombstone WHERE year = ?').run(YEAR);
});

async function addEntry(num, univ = 'U', team = `T${num}`) {
  const res = await client.post(`/api/entries?year=${YEAR}`, {
    body: { num, univ, team },
    cookie: adminCookie,
  });
  assert.equal(res.status, 201);
}

async function getEntries(includeInactive = false) {
  const res = await client.get(
    `/api/entries?year=${YEAR}${includeInactive ? '&includeInactive=true' : ''}`,
    { cookie: adminCookie },
  );
  assert.equal(res.status, 200);
  return res.json();
}

async function getTeamState() {
  const res = await client.get(`/api/internal/team-state?year=${YEAR}`, {
    headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
  });
  assert.equal(res.status, 200);
  return res.json();
}

describe('immutable team id', () => {
  it('mints an id on create and exposes it in /api/entries', async () => {
    await addEntry(1);
    const entries = await getEntries();
    assert.ok(Number.isInteger(entries[1].id) && entries[1].id >= 1);
  });

  it('mints unique ids across years', async () => {
    await addEntry(1);
    const other = await client.post(`/api/entries?year=${YEAR + 1}`, {
      body: { num: 1, univ: 'U', team: 'T-other-year' },
      cookie: adminCookie,
    });
    assert.equal(other.status, 201);
    const a = (await getEntries())[1].id;
    const bRes = await client.get(`/api/entries?year=${YEAR + 1}`, { cookie: adminCookie });
    const b = (await bRes.json())[1].id;
    assert.notEqual(a, b);
    await client.delete(`/api/entries?year=${YEAR + 1}`, { cookie: adminCookie });
  });

  it('keeps the id across a rename (retain identity semantics)', async () => {
    await addEntry(5, 'Univ', 'Old Name');
    const before = (await getEntries())[5].id;
    const res = await client.patch(`/api/entries/5?year=${YEAR}`, {
      body: { num: 5, univ: 'Univ', team: 'New Name', intent: 'retain' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const entries = await getEntries();
    assert.equal(entries[5].team, 'New Name');
    assert.equal(entries[5].id, before, 'rename must not change the immutable id');
  });

  it('keeps the id across a renumber', async () => {
    await addEntry(5);
    const before = (await getEntries())[5].id;
    const res = await client.patch(`/api/entries/5?year=${YEAR}`, {
      body: { num: 12, univ: 'U', team: 'T5' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const entries = await getEntries();
    assert.equal(entries[12].id, before, 'renumber must not change the immutable id');
  });

  it('keeps the id across activate/deactivate', async () => {
    await addEntry(7);
    const before = (await getEntries())[7].id;
    await client.patch(`/api/entries/7/active?year=${YEAR}`, { body: { active: false }, cookie: adminCookie });
    await client.patch(`/api/entries/7/active?year=${YEAR}`, { body: { active: true }, cookie: adminCookie });
    assert.equal((await getEntries())[7].id, before);
  });

  it('replacement mints a new id and tombstones the old team', async () => {
    await addEntry(9, 'Univ A', 'Team A');
    const oldId = (await getEntries())[9].id;
    const res = await client.patch(`/api/entries/9?year=${YEAR}`, {
      body: { num: 9, univ: 'Univ B', team: 'Team B', intent: 'replacement' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const newId = (await getEntries())[9].id;
    assert.notEqual(newId, oldId, 'replacement must mint a fresh id');

    const state = await getTeamState();
    const tomb = state.tombstones.find((t) => t.id === oldId);
    assert.ok(tomb, 'old team must be tombstoned');
    assert.equal(tomb.num, 9);
  });

  it('backfills ids for legacy rows without one', async () => {
    // id 없이 직접 삽입해 레거시 행을 흉내낸다 (마이그레이션은 부팅 시 1회라, 새 연도
    // 테이블을 factory 재생성으로 다시 태운다)
    const legacyYear = YEAR + 50;
    db.exec(`CREATE TABLE IF NOT EXISTS entry_${legacyYear} (
      num INTEGER PRIMARY KEY, univ TEXT NOT NULL, team TEXT NOT NULL,
      type TEXT DEFAULT NULL, active INTEGER NOT NULL DEFAULT 1,
      active_revision INTEGER NOT NULL DEFAULT 0
    )`);
    db.prepare(`INSERT INTO entry_${legacyYear} (num, univ, team) VALUES (1, 'U', 'Legacy')`).run();

    const second = createEntryApp({ dbPath, validateUser: TRUST_JWT, skipReconcileOnBoot: true });
    try {
      const row = second.db.prepare(`SELECT id FROM entry_${legacyYear} WHERE num = 1`).get();
      assert.ok(Number.isInteger(row.id) && row.id >= 1, 'legacy row must receive a minted id');
    } finally {
      second.stopLifecycleOutboxRetry?.();
      second.db.close();
      db.exec(`DROP TABLE entry_${legacyYear}`);
    }
  });
});

describe('tombstones', () => {
  it('single delete writes a tombstone with the team identity', async () => {
    await addEntry(3, 'Univ X', 'Team X');
    const id = (await getEntries())[3].id;
    await client.delete(`/api/entries/3?year=${YEAR}`, { cookie: adminCookie });
    const state = await getTeamState();
    assert.ok(state.tombstones.some((t) => t.id === id && t.num === 3));
    const row = db.prepare('SELECT * FROM team_tombstone WHERE team_id = ?').get(id);
    assert.equal(row.univ, 'Univ X');
    assert.equal(row.team, 'Team X');
  });

  it('clear-all tombstones every team', async () => {
    await addEntry(1);
    await addEntry(2);
    const ids = Object.values(await getEntries()).map((e) => e.id);
    await client.delete(`/api/entries?year=${YEAR}`, { cookie: adminCookie });
    const state = await getTeamState();
    for (const id of ids) {
      assert.ok(state.tombstones.some((t) => t.id === id));
    }
  });
});

describe('state version', () => {
  async function version() {
    return (await getTeamState()).version;
  }

  it('bumps once per mutation (create, update, active, delete)', async () => {
    const v0 = await version();
    await addEntry(1);
    const v1 = await version();
    assert.equal(v1, v0 + 1);
    await client.patch(`/api/entries/1?year=${YEAR}`, {
      body: { num: 1, univ: 'U', team: 'T1', type: null },
      cookie: adminCookie,
    });
    const v2 = await version();
    assert.equal(v2, v1 + 1);
    await client.patch(`/api/entries/1/active?year=${YEAR}`, { body: { active: false }, cookie: adminCookie });
    const v3 = await version();
    assert.equal(v3, v2 + 1);
    await client.delete(`/api/entries/1?year=${YEAR}`, { cookie: adminCookie });
    assert.equal(await version(), v3 + 1);
  });

  it('does not bump on a no-op active toggle', async () => {
    await addEntry(1);
    const v = await version();
    await client.patch(`/api/entries/1/active?year=${YEAR}`, { body: { active: true }, cookie: adminCookie });
    assert.equal(await version(), v);
  });

  it('bumps when a vehicle-type rename rewrites entry types', async () => {
    const vt = await client.post(`/api/vehicle-types?year=${YEAR}`, {
      body: { name: 'TS-Type' },
      cookie: adminCookie,
    });
    assert.equal(vt.status, 201);
    const { id: vtId } = await vt.json();
    const res = await client.post(`/api/entries?year=${YEAR}`, {
      body: { num: 1, univ: 'U', team: 'T1', type: 'TS-Type' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const v = await version();
    const rename = await client.patch(`/api/vehicle-types/${vtId}?year=${YEAR}`, {
      body: { name: 'TS-Type-2' },
      cookie: adminCookie,
    });
    assert.equal(rename.status, 200);
    assert.equal(await version(), v + 1, 'entry.type rewrite must bump the state version');
    await client.delete(`/api/vehicle-types/${vtId}?year=${YEAR}`, { cookie: adminCookie });
  });
});

describe('GET /api/internal/team-state', () => {
  it('rejects non-internal callers', async () => {
    const res = await client.get(`/api/internal/team-state?year=${YEAR}`, { cookie: adminCookie });
    assert.equal(res.status, 403);
  });

  it('returns an empty snapshot for a year with no table (and creates none)', async () => {
    const ghostYear = 2099;
    const res = await client.get(`/api/internal/team-state?year=${ghostYear}`, {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { year: ghostYear, version: 0, teams: {}, tombstones: [] });
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(`entry_${ghostYear}`);
    assert.equal(table, undefined, 'empty-year snapshot must not create the table');
  });

  it('rejects an invalid year', async () => {
    const res = await client.get('/api/internal/team-state?year=DROP', {
      headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
    });
    assert.equal(res.status, 400);
  });

  it('returns teams keyed by id with num/identity/active', async () => {
    await addEntry(4, 'Univ Y', 'Team Y');
    await client.patch(`/api/entries/4/active?year=${YEAR}`, { body: { active: false }, cookie: adminCookie });
    const state = await getTeamState();
    const id = Object.keys(state.teams).find((k) => state.teams[k].num === 4);
    assert.ok(id);
    assert.deepEqual(state.teams[id], { num: 4, univ: 'Univ Y', team: 'Team Y', type: null, active: false });
    assert.ok(state.version >= 2);
  });
});

describe('bulk upload id preservation', () => {
  async function bulkUpload(data, extra = {}) {
    return client.post(`/api/entries/bulk?year=${YEAR}`, {
      body: { data, ...extra },
      cookie: adminCookie,
    });
  }

  it('identity-matched rows inherit their id across a bulk renumber', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    await addEntry(2, 'Univ B', 'Team B');
    const before = await getEntries();
    const res = await bulkUpload({
      11: { univ: 'Univ A', team: 'Team A' },
      2: { univ: 'Univ B', team: 'Team B' },
    });
    assert.equal(res.status, 200);
    const after = await getEntries();
    assert.equal(after[11].id, before[1].id, 'identity match across nums must inherit the id');
    assert.equal(after[2].id, before[2].id);
  });

  it('replacement rows mint a new id and tombstone the old one', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    const oldId = (await getEntries())[1].id;
    const res = await bulkUpload(
      { 1: { univ: 'Univ Z', team: 'Team Z' } },
      { replacements: [1] },
    );
    assert.equal(res.status, 200);
    const after = await getEntries();
    assert.notEqual(after[1].id, oldId);
    assert.ok((await getTeamState()).tombstones.some((t) => t.id === oldId));
  });

  it('retained rows (명칭 정정) keep their id despite the identity change', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    const oldId = (await getEntries())[1].id;
    const res = await bulkUpload(
      { 1: { univ: 'Univ A', team: 'Team A (기명 정정)' } },
      { retains: [1] },
    );
    assert.equal(res.status, 200);
    assert.equal((await getEntries())[1].id, oldId);
  });

  it('deleted rows are tombstoned', async () => {
    await addEntry(1);
    await addEntry(2);
    const id2 = (await getEntries())[2].id;
    const res = await bulkUpload({ 1: { univ: 'U', team: 'T1' } });
    assert.equal(res.status, 200);
    assert.ok((await getTeamState()).tombstones.some((t) => t.id === id2));
  });

  it('an uploaded id is an authoritative match key (renumber + rename without 409)', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    const id = (await getEntries())[1].id;
    // 번호도 정체성도 바뀌지만 id가 같은 팀임을 증명 → ambiguous 없이 승계
    const res = await bulkUpload({ 21: { id, univ: 'Univ A2', team: 'Team A2' } });
    assert.equal(res.status, 200);
    const after = await getEntries();
    assert.equal(after[21].id, id);
    assert.equal(after[21].team, 'Team A2');
    assert.equal((await getTeamState()).tombstones.length, 0, 'id-matched row must not be tombstoned');
  });

  it('same-num identity change with a matching id is treated as a rename (no 409)', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    const id = (await getEntries())[1].id;
    const res = await bulkUpload({ 1: { id, univ: 'Univ A', team: 'Renamed' } });
    assert.equal(res.status, 200);
    assert.equal((await getEntries())[1].id, id);
  });

  it('same-num identity change without id or intent still 409s as ambiguous', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    const res = await bulkUpload({ 1: { univ: 'Univ B', team: 'Team B' } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.ambiguous?.length === 1);
  });

  it('rejects an unknown uploaded id', async () => {
    await addEntry(1);
    const res = await bulkUpload({ 1: { id: 999999, univ: 'U', team: 'T1' } });
    assert.equal(res.status, 400);
  });

  it('rejects duplicate uploaded ids', async () => {
    await addEntry(1);
    const id = (await getEntries())[1].id;
    const res = await bulkUpload({
      1: { id, univ: 'U', team: 'T1' },
      2: { id, univ: 'U', team: 'T2' },
    });
    assert.equal(res.status, 400);
  });

  it('rejects an id match that contradicts an explicit renumber mapping', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    await addEntry(2, 'Univ B', 'Team B');
    const id1 = (await getEntries())[1].id;
    // renumbers는 2→30을 선언하는데 업로드 행 30의 id는 팀 1을 가리킨다 → 모순
    const res = await bulkUpload(
      { 30: { id: id1, univ: 'Univ A', team: 'Team A' } },
      { renumbers: { 2: 30 } },
    );
    assert.equal(res.status, 400);
  });

  it('?download output round-trips: re-uploading it verbatim is a no-op that keeps ids', async () => {
    await addEntry(1, 'Univ A', 'Team A');
    await addEntry(2, 'Univ B', 'Team B');
    const downloaded = await (await client.get(`/api/entries?year=${YEAR}&includeInactive=true&download`, {
      cookie: adminCookie,
    })).json();
    const before = await getEntries();
    const res = await bulkUpload(downloaded);
    assert.equal(res.status, 200);
    const after = await getEntries();
    assert.equal(after[1].id, before[1].id);
    assert.equal(after[2].id, before[2].id);
    assert.equal((await getTeamState()).tombstones.length, 0);
  });
});
