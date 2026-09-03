import { describe, it, before, after } from 'node:test';
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
  TEST_SECRET,
} from '../helpers/test-utils.mjs';
import { createScoreApp } from '../../score/index.mjs';
import { currentCompetitionYear } from '../../shared/competition-year.mjs';

const requireFromScore = createRequire(import.meta.resolve('../../score/index.mjs'));
const Database = requireFromScore('better-sqlite3');
const CURRENT_YEAR = currentCompetitionYear();

let mockEntryRequestCount = 0;
let mockEntryTeamName = '팀A';

const mainRecords = [
  { rowid: 1, time: '2026-01-01T10:00:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 50000, status: null, cones: 0, oc: 0, scoreboard: 1 },
  { rowid: 2, time: '2026-01-01T10:05:00', num: 1, univ: '서울대', team: '팀A', type: '가속', result: 48000, status: null, cones: 1, oc: 0, scoreboard: 1 },
  { rowid: 3, time: '2026-01-01T10:10:00', num: 2, univ: '카이스트', team: '팀B', type: '가속', result: 52000, status: null, cones: 0, oc: 1, scoreboard: 1 },
];
const richTemplate = [{
  id: 100, year: 2026, level: 'category', name: '코너웨이트', sort_order: 0,
  subcategories: [{
    id: 101, year: 2026, level: 'subcategory', name: '측정', sort_order: 0, parent_id: 100,
    groups: [{
      id: 102, year: 2026, level: 'group', name: '값', sort_order: 0, parent_id: 101,
      items: [
        { id: 201, name: '공차중량', answer_type: 'number', year: 2026, level: 'item', sort_order: 0 },
        { id: 202, name: 'FL', answer_type: 'number', year: 2026, level: 'item', sort_order: 1 },
        { id: 203, name: 'FR', answer_type: 'number', year: 2026, level: 'item', sort_order: 2 },
        { id: 204, name: 'RL', answer_type: 'number', year: 2026, level: 'item', sort_order: 3 },
        { id: 205, name: 'RR', answer_type: 'number', year: 2026, level: 'item', sort_order: 4 },
      ],
    }],
  }],
}];

function teamEntries(year, rich = false) {
  mockEntryRequestCount++;
  const energyIntegration = [2087, 2088].includes(Number(year));
  const entries = {
    1: { id: 1, num: 1, univ: '서울대', team: mockEntryTeamName, type: energyIntegration ? 'C-Formula' : 'EV', active: true },
    2: { id: 2, num: 2, univ: '카이스트', team: '팀B', type: energyIntegration ? 'E-Formula' : 'EV', active: true },
  };
  if (rich) entries[3] = { id: 3, num: 3, univ: '연세대', team: '팀C', type: 'EV', active: true };
  if (rich) entries[4] = { id: 4, num: 4, univ: '한양대', team: '팀D', type: 'EV', active: true };
  return entries;
}

function createCompetitionQueries({ rich = false, records = null, modes = null } = {}) {
  return {
    teams: { moduleEntries: (year) => teamEntries(year, rich) },
    inspection: {
      summary: () => ({ categories: [{ id: rich ? 100 : 1, name: '코너웨이트' }], teams: {} }),
      templateTree: () => rich ? richTemplate : [],
      bulkAnswers: () => rich ? { 1: { 201: '250', 202: '63', 203: '62', 204: '64', 205: '61' } } : {},
    },
    traffic: {
      yearRecordGroups: (year) => records ? records(year) : rich ? [
      {
        name: `FSK ${year} 가속 1차`,
        records: [
          { rowid: 1, time: '2026-01-01T10:00:00Z', num: 1, univ: 'A', team: 'A', type: '가속', result: 50000, status: null, cones: 1, oc: 0, scoreboard: 1 },
          { rowid: 2, time: '2026-01-01T10:01:00Z', num: 2, univ: 'B', team: 'B', type: '가속', result: 48000, status: 'DNF', cones: 0, oc: 0, scoreboard: 0 },
          { rowid: 3, time: '2026-01-01T10:02:00Z', num: 3, univ: 'C', team: 'C', type: '가속', result: null, status: 'DNF', cones: 0, oc: 0, scoreboard: 1 },
        ],
      },
      {
        name: `FSK ${year} 가속 2차`,
        records: [
          { rowid: 4, time: '2026-01-01T10:03:00Z', num: 1, univ: 'A', team: 'A', type: '가속', result: 55000, status: null, cones: 0, oc: 0, scoreboard: 1 },
          { rowid: 5, time: '2026-01-01T10:04:00Z', num: 2, univ: 'B', team: 'B', type: '가속', result: 49000, status: 'DSQ', cones: 0, oc: 0, scoreboard: 0 },
          { rowid: 6, time: '2026-01-01T10:05:00Z', num: 3, univ: 'C', team: 'C', type: '가속', result: null, status: 'DNF', cones: 0, oc: 0, scoreboard: 1 },
          { rowid: 8, time: '2026-01-01T10:06:00Z', num: 2, univ: 'B', team: 'B', type: '가속', result: null, status: 'DNS', cones: 0, oc: 0, scoreboard: 1 },
          { rowid: 9, time: '2026-01-01T10:07:00Z', num: 4, univ: 'D', team: 'D', type: '가속', result: null, status: 'DNS', cones: 0, oc: 0, scoreboard: 1 },
        ],
      },
      {
        name: `FSK ${year} 스키드패드`,
        records: [
          { rowid: 7, time: '2026-01-01T10:06:00Z', num: 1, univ: 'A', team: 'A', type: '스키드패드', result: 30000, status: null, cones: 0, oc: 0, scoreboard: 1 },
        ],
      },
    ] : [{ name: `FSK ${year} 가속 1차`, records: mainRecords }],
      eventModes: () => modes ?? (rich ? [
        { event_type: '가속', enabled: 1 },
        { event_type: '스키드패드', enabled: 0 },
        { event_type: '오토크로스', enabled: 1 },
      ] : [
        { event_type: '가속', enabled: 1 },
        { event_type: '스키드패드', enabled: 1 },
      ]),
    },
  };
}

const mainCompetitionQueries = createCompetitionQueries();

// ─── Setup ──────────────────────────────────────────────────────────────

setupTestEnv();

let server, baseUrl, client, db, dbPath;

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const masterCookie = makeAuthCookie({ email: 'master@test.com', name: 'Master', role: 'master' });
const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });

before(async () => {
  dbPath = tmpDbPath();
  const result = createScoreApp({
    dbPath,
    skipSSESubscriptions: true,
    validateUser: TRUST_JWT,
    competitionQueries: mainCompetitionQueries,
  });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

describe('Score mutation preflight auditing', () => {
  it('audits inactive teams and canonical/report-limit lookup failures', async () => {
    const isolatedPath = tmpDbPath();
    const rawDb = new Database(isolatedPath);
    rawDb.exec(`
      CREATE TABLE competition_team (
        id INTEGER PRIMARY KEY,
        year INTEGER NOT NULL,
        num INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      INSERT INTO competition_team (id, year, num, active) VALUES
        (991, ${CURRENT_YEAR}, 991, 0),
        (992, ${CURRENT_YEAR}, 992, 1);
    `);
    let failCanonicalLookup = false;
    let failReportLimitLookup = false;
    const proxyDb = new Proxy(rawDb, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (failCanonicalLookup && sql.includes('sqlite_master') && sql.includes('competition_team')) {
              throw new Error('injected score team lookup failure');
            }
            if (failReportLimitLookup && sql.includes('score_setting') && sql.includes("event_type = '보고서'")) {
              throw new Error('injected report limit lookup failure');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const created = createScoreApp({
      db: proxyDb,
      validateUser: TRUST_JWT,
      skipSSESubscriptions: true,
      competitionQueries: mainCompetitionQueries,
    });
    const started = await startServer(created.app);
    const isolated = createClient(started.baseUrl);
    try {
      const inactiveManual = await isolated.put('/api/score/manual', {
        body: { year: CURRENT_YEAR, team_num: 991, score_type: 'bonus', value: 3 },
        cookie: adminCookie,
      });
      const inactiveEndurance = await isolated.put('/api/score/endurance', {
        body: { year: CURRENT_YEAR, team_num: 991, field: 'driver1_time', value: 1000 },
        cookie: adminCookie,
      });
      assert.deepEqual([inactiveManual.status, inactiveEndurance.status], [409, 409]);

      failCanonicalLookup = true;
      const failedTeamLookup = await isolated.put('/api/score/manual', {
        body: { year: CURRENT_YEAR, team_num: 992, score_type: 'bonus', value: 4 },
        cookie: adminCookie,
      });
      assert.equal(failedTeamLookup.status, 500);
      assert.equal(await failedTeamLookup.text(), '팀 활성 상태를 확인할 수 없습니다.');
      failCanonicalLookup = false;

      failReportLimitLookup = true;
      const failedReportLimit = await isolated.put('/api/score/manual', {
        body: { year: CURRENT_YEAR, team_num: 992, score_type: 'report', value: 5 },
        cookie: adminCookie,
      });
      assert.equal(failedReportLimit.status, 500);
      assert.equal(await failedReportLimit.text(), '보고서 점수 제한을 확인할 수 없습니다.');
      failReportLimitLookup = false;

      const logs = rawDb.prepare(`
        SELECT action, detail FROM logs
        WHERE level = 'warn' AND action IN ('manual_score.update', 'endurance.update')
        ORDER BY id
      `).all();
      assert.deepEqual(logs.map((row) => row.action), [
        'manual_score.update', 'endurance.update', 'manual_score.update', 'manual_score.update',
      ]);
      const details = logs.map((row) => JSON.parse(row.detail));
      assert.equal(details[0].error, 'inactive_or_missing_team');
      assert.equal(details[1].error, 'inactive_or_missing_team');
      assert.equal(details[2].error, 'injected score team lookup failure');
      assert.equal(details[2].phase, 'canonical_team_lookup');
      assert.equal(details[3].error, 'injected report limit lookup failure');
      assert.equal(details[3].phase, 'report_limit_lookup');
    } finally {
      await stopServer(started.server);
      created.closeSse?.();
      rawDb.close();
      cleanup(isolatedPath);
    }
  });
});

// ─── Health ─────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

// ─── Manual Scores ──────────────────────────────────────────────────────

describe('PUT /api/score/manual', () => {
  it('creates and updates a manual score', async () => {
    let res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 85 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 90 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const row = db.prepare(
      "SELECT value FROM score_manual WHERE year = 2026 AND team_num = 1 AND score_type = 'report'"
    ).get();
    assert.equal(row.value, 90);
  });

  it('rejects missing fields', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year range (too low)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 1999, team_num: 1, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year range (too high)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2100, team_num: 1, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates team_num (less than 1)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 0, score_type: 'report', value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates score_type key length (>50 chars)', async () => {
    const longKey = 'a'.repeat(51);
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: longKey, value: 10 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects legacy manual energy scores', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 2, score_type: 'energy', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-finite value (NaN)', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 'not-a-number' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Penalties ──────────────────────────────────────────────────────────

describe('PUT /api/score/penalty', () => {
  it('upserts a penalty config', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      db.prepare("SELECT cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = 2026 AND event_type = '가속'").get(),
      { cone_penalty: 2, oc_penalty: 10, start_delay: 5 }
    );
  });

  it('rejects missing fields', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative values', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '가속', cone_penalty: -1, oc_penalty: 0, start_delay: 0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('defaults null values to 0', async () => {
    const res = await client.put('/api/score/penalty', {
      body: { year: 2026, event_type: '스키드패드', cone_penalty: null, oc_penalty: null, start_delay: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      db.prepare("SELECT cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = 2026 AND event_type = '스키드패드'").get(),
      { cone_penalty: 0, oc_penalty: 0, start_delay: 0 }
    );
  });
});

// ─── Settings ───────────────────────────────────────────────────────────

describe('PUT /api/score/setting', () => {
  it('upserts a score setting', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: 'total_score', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal(
      db.prepare("SELECT value FROM score_setting WHERE year = 2026 AND event_type = '가속' AND setting_key = 'total_score'").get().value,
      75
    );
  });

  it('validates event_type key (empty)', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '', setting_key: 'total_score', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates setting_key (empty)', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: '', value: 75 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative values', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '가속', setting_key: 'total_score', value: -1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('allows null value', async () => {
    const res = await client.put('/api/score/setting', {
      body: { year: 2026, event_type: '스키드패드', setting_key: 'cutoff', value: null },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    assert.equal(
      db.prepare("SELECT value FROM score_setting WHERE year = 2026 AND event_type = '스키드패드' AND setting_key = 'cutoff'").get().value,
      null
    );
  });
});

// ─── Endurance ──────────────────────────────────────────────────────────

describe('GET /api/score/endurance (initial)', () => {
  it('returns empty object initially', async () => {
    const res = await client.get('/api/score/endurance?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, {});
  });
});

describe('PUT /api/score/endurance', () => {
  it('upserts a driver1_time field', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: 120000 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('persists trimmed driver names, clears blank names, and enforces the length limit', async () => {
    for (const [field, value] of [
      ['driver1_name', '  홍길동  '],
      ['driver2_name', '김드라이버'],
    ]) {
      const res = await client.put('/api/score/endurance', {
        body: { year: 2026, team_num: 1, field, value },
        cookie: adminCookie,
      });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(
      db.prepare('SELECT driver1_name, driver2_name FROM score_endurance WHERE year = 2026 AND team_num = 1').get(),
      { driver1_name: '홍길동', driver2_name: '김드라이버' },
    );

    const cleared = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver2_name', value: '   ' },
      cookie: adminCookie,
    });
    assert.equal(cleared.status, 200);
    assert.equal(
      db.prepare('SELECT driver2_name FROM score_endurance WHERE year = 2026 AND team_num = 1').get().driver2_name,
      null,
    );

    const tooLong = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver1_name', value: '가'.repeat(101) },
      cookie: adminCookie,
    });
    assert.equal(tooLong.status, 400);
    assert.equal(
      db.prepare('SELECT driver1_name FROM score_endurance WHERE year = 2026 AND team_num = 1').get().driver1_name,
      '홍길동',
    );
  });

  it('accepts every supported status and allows clearing it', async () => {
    for (const status of ['DNF', 'DNS', 'DSQ', null]) {
      const res = await client.put('/api/score/endurance', {
        body: { year: 2026, team_num: 2, field: 'status', value: status },
        cookie: adminCookie,
      });
      assert.equal(res.status, 200);
      assert.equal(
        db.prepare('SELECT status FROM score_endurance WHERE year = 2026 AND team_num = 2').get().status,
        status
      );
    }
  });

  it('rejects invalid status', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'status', value: 'INVALID' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects negative numeric values', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: -1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('accepts energy fields and permits negative net electric energy only', async () => {
    const net = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'electric_net_energy', value: -0.5 },
      cookie: adminCookie,
    });
    assert.equal(net.status, 200);

    const fuel = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'fuel_consumed', value: -0.5 },
      cookie: adminCookie,
    });
    assert.equal(fuel.status, 400);
  });

  it('rejects manual energy type and DSQ reason, and validates the DSQ flag', async () => {
    const badType = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_type', value: 'E' },
      cookie: adminCookie,
    });
    assert.equal(badType.status, 400);

    const badDsq = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_dsq', value: 2 },
      cookie: adminCookie,
    });
    assert.equal(badDsq.status, 400);

    const reason = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'energy_dsq_reason', value: '봉인 훼손' },
      cookie: adminCookie,
    });
    assert.equal(reason.status, 400);
  });

  it('persists and validates the endurance qualification flag with audit context', async () => {
    const qualified = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'qualified', value: 1 },
      cookie: adminCookie,
    });
    assert.equal(qualified.status, 200);
    assert.equal(
      db.prepare('SELECT qualified FROM score_endurance WHERE year = 2026 AND team_num = 1').get().qualified,
      1,
    );

    const invalid = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'qualified', value: 2 },
      cookie: adminCookie,
    });
    assert.equal(invalid.status, 400);

    for (const value of [null, '']) {
      const empty = await client.put('/api/score/endurance', {
        body: { year: 2026, team_num: 1, field: 'qualified', value },
        cookie: adminCookie,
      });
      assert.equal(empty.status, 400);
    }

    assert.equal(
      db.prepare('SELECT qualified FROM score_endurance WHERE year = 2026 AND team_num = 1').get().qualified,
      1,
    );

    const warnings = db.prepare(`
      SELECT detail FROM logs
      WHERE level = 'warn' AND action = 'endurance.update' AND target = '#1'
      ORDER BY id DESC LIMIT 3
    `).all().map(({ detail }) => JSON.parse(detail));
    assert.deepEqual(warnings.map(({ reason, field, requested }) => ({ reason, field, requested })), [
      { reason: 'invalid_toggle_value', field: 'qualified', requested: '' },
      { reason: 'invalid_toggle_value', field: 'qualified', requested: null },
      { reason: 'invalid_toggle_value', field: 'qualified', requested: 2 },
    ]);

    const audit = db.prepare(`
      SELECT detail FROM logs
      WHERE level = 'info' AND action = 'endurance.update' AND target = '#1'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(audit.detail), {
      team: {
        id: 1,
        year: 2026,
        number: 1,
        university: '서울대',
        name: '팀A',
        active: true,
      },
      year: 2026,
      field: 'qualified',
      before: 0,
      after: 1,
    });
  });

  it('rejects non-allowed field', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 1, field: 'hackerfield', value: 999 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates year (too low)', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 1999, team_num: 1, field: 'driver1_time', value: 100 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('validates team_num (less than 1)', async () => {
    const res = await client.put('/api/score/endurance', {
      body: { year: 2026, team_num: 0, field: 'driver1_time', value: 100 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/score/endurance (after writes)', () => {
  it('returns set endurance data', async () => {
    const res = await client.get('/api/score/endurance?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Team 1 should have driver1_time = 120000
    assert.ok(data['1']);
    assert.equal(data['1'].driver1_time, 120000);
    // Team 2 should exist (status was set then cleared)
    assert.ok(data['2']);
    assert.equal(data['1'].fuel_extra, null);
    assert.equal(data['1'].qualified, 1);
    assert.equal(data['1'].driver1_name, '홍길동');
    assert.equal(data['1'].driver2_name, null);
    assert.equal('energy_dsq_reason' in data['1'], false);
  });
});

// ─── GET /api/score (main aggregation) ──────────────────────────────────

describe('GET /api/score', () => {
  // Set up a second manual score for team 2 to verify aggregation
  before(async () => {
    await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 2, score_type: 'report', value: 70 },
      cookie: adminCookie,
    });
  });

  it('rejects missing year', async () => {
    const res = await client.get('/api/score', { cookie: adminCookie });
    assert.equal(res.status, 400);
  });

  it('aggregates entries, inspection, event records, manual scores, penalties, and settings', async () => {
    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.entries);
    assert.ok(data.inspection);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.manualScores);
    assert.ok(data.penalties);
    assert.ok(data.settings);
    assert.equal(data.entries['1'].univ, '서울대');
    assert.equal(data.entries['2'].univ, '카이스트');

    const accelEvent = data.events.find(e => e.type === '가속');
    assert.ok(accelEvent, 'should have 가속 event');
    assert.ok(accelEvent.records, 'should have records');
    assert.ok(accelEvent.records['1'], 'team 1 should have records');
    assert.ok(accelEvent.records['2'], 'team 2 should have records');

    assert.equal(data.manualScores['1'].report, 90);
    assert.equal(data.manualScores['2'].report, 70);

    assert.ok(data.penalties['가속']);
    assert.equal(data.penalties['가속'].cone_penalty, 2);
    assert.equal(data.penalties['가속'].oc_penalty, 10);
    assert.equal(data.penalties['가속'].start_delay, 5);

    assert.ok(data.settings['가속']);
    assert.equal(data.settings['가속'].total_score, 75);

    const enduranceEvent = data.events.find(e => e.type === '내구');
    assert.ok(enduranceEvent, 'should have 내구 event');
    assert.ok(enduranceEvent.records, 'should have endurance records');
  });

  it('penalty calculation: best run selected with penalty-adjusted time', async () => {
    const year = currentCompetitionYear();
    // First set penalty config for current year
    await client.put('/api/score/penalty', {
      body: { year, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 0 },
      cookie: adminCookie,
    });

    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    const data = await res.json();
    const accelEvent = data.events.find(e => e.type === '가속');

    // Team 1 has two runs:
    //   Run 1: result=50000, cones=0, oc=0 → adjusted = 50000
    //   Run 2: result=48000, cones=1, oc=0 → adjusted = 48000 + 1*2*1000 = 50000
    // Both have the same adjusted time; the reduce picks the first (run 1)
    // So best result should be 50000 with cones=0
    assert.equal(accelEvent.records['1'].result, 50000);
    assert.equal(accelEvent.records['1'].cones, 0);

    // Team 2 has one run:
    //   Run 3: result=52000, cones=0, oc=1 → adjusted = 52000 + 0 + 1*10*1000 = 62000
    // Only one valid run, so that's the best
    assert.equal(accelEvent.records['2'].result, 52000);
    assert.equal(accelEvent.records['2'].cones, 0);
    assert.equal(accelEvent.records['2'].oc, 1);
  });

});

// ─── Endurance calculation in aggregation ────────────────────────────────

describe('Endurance calculation in aggregation', () => {
  it('DNS entry is represented explicitly without a result', async () => {
    // Set team 2 status to DNS
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNS' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.equal(endurance.records[2].result, null);
    assert.equal(endurance.records[2].status, 'DNS');
  });

  it('DNF entry has an explicit status and no result sentinel', async () => {
    // Set team 2 status to DNF
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DNF' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[2], 'DNF entry should be present');
    assert.equal(endurance.records[2].result, null);
    assert.equal(endurance.records[2].status, 'DNF');
  });

  it('DSQ entry has an explicit status and no result sentinel', async () => {
    // Set team 2 status to DSQ
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: 'DSQ' },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[2], 'DSQ entry should be present');
    assert.equal(endurance.records[2].result, null);
    assert.equal(endurance.records[2].status, 'DSQ');
  });

  it('calculates normal endurance time with all components', async () => {
    // Set up endurance penalty config
    await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '내구', cone_penalty: 2, oc_penalty: 10, start_delay: 5 },
    });

    // Clear status for team 1
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'status', value: null },
    });
    // Set all time fields for team 1
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_time', value: 60000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_time', value: 65000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver_change_time', value: 5000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_start_delay', value: 2 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_start_delay', value: 1 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_cones', value: 3 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_cones', value: 2 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_oc', value: 1 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_oc', value: 0 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver1_penalty', value: 10 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 1, field: 'driver2_penalty', value: 5 },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    assert.ok(endurance, '내구 event should exist');
    assert.ok(endurance.records[1], 'team 1 should have endurance record');

    // Expected calculation:
    // startDelayMs = (2 + 1) * 5 * 1000 = 15000
    // manualPenaltyMs = (10 + 5) * 1000 = 15000
    // result = 60000 + 65000 + 5000 + 15000 + 15000 = 160000
    assert.equal(endurance.records[1].result, 160000, 'endurance time should include all components');
    assert.equal(endurance.records[1].cones, 5, 'cones should be sum of both drivers');
    assert.equal(endurance.records[1].oc, 1, 'oc should be sum of both drivers');
  });

  it('skips endurance record when time fields are incomplete', async () => {
    // Clear team 2 status first so it's not DNS/DNF/DSQ
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'status', value: null },
    });
    // Set partial time fields (driver1_time and driver_change_time but NOT driver2_time)
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver1_time', value: 60000 },
    });
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver_change_time', value: 5000 },
    });
    // driver2_time is NOT set (null) — ensure it's null by clearing it
    await client.put('/api/score/endurance', {
      cookie: adminCookie,
      body: { year: 2026, team_num: 2, field: 'driver2_time', value: null },
    });

    const res = await client.get('/api/score?year=2026', { cookie: adminCookie });
    const data = await res.json();
    const endurance = data.events.find(e => e.type === '내구');
    // Team 2 should be skipped because driver2_time is null
    assert.equal(endurance.records[2], undefined, 'incomplete endurance record should be skipped');
  });
});

describe('Energy score integration', () => {
  const year = 2088;

  before(() => {
    const insertSetting = db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', ?, ?)");
    insertSetting.run(year, 'total', 35);
    insertSetting.run(year, 'distance_km', 20);
    insertSetting.run(year, 'fuel_factor', 2.31);
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '보고서', 'total', ?)").run(year, 50);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO score_endurance
        (year, team_num, driver1_time, driver_change_time, driver2_time, fuel_consumed, electric_net_energy)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `);
    insert.run(year, 1, 50_000, 50_000, 1, null);
    insert.run(year, 2, 55_000, 55_000, null, 2);
  });

  it('returns energy scores with a blank driver-change overrun treated as zero', async () => {
    const res = await client.get(`/api/score?year=${year}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.energy.config.total, 35);
    assert.equal(data.energy.teams['1'].status, 'SCORED');
    assert.equal(data.energy.teams['1'].energyType, 'C');
    assert.equal(data.energy.teams['1'].score, 35);
    assert.equal(data.energy.teams['2'].energyType, 'E');
    assert.equal(data.energy.teams['2'].score, 0);
  });

  it('enforces the configured report maximum', async () => {
    const over = await client.put('/api/score/manual', {
      cookie: adminCookie,
      body: { year, team_num: 1, score_type: 'report', value: 51 },
    });
    assert.equal(over.status, 400);

    const exact = await client.put('/api/score/manual', {
      cookie: adminCookie,
      body: { year, team_num: 1, score_type: 'report', value: 50 },
    });
    assert.equal(exact.status, 200);
  });

  it('returns corrected CO2/100km before endurance time and score settings are complete', async () => {
    const incompleteYear = 2087;
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', 'distance_km', ?)").run(incompleteYear, 20);
    db.prepare("INSERT OR REPLACE INTO score_setting (year, event_type, setting_key, value) VALUES (?, '에너지', 'fuel_factor', ?)").run(incompleteYear, 2.31);
    db.prepare("INSERT OR REPLACE INTO score_endurance (year, team_num, fuel_consumed) VALUES (?, ?, ?)").run(incompleteYear, 1, 1);

    const res = await client.get(`/api/score?year=${incompleteYear}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.energy.teams['1'].status, 'PENDING');
    assert.equal(data.energy.teams['1'].correctedCo2, 2.31);
    assert.equal(data.energy.teams['1'].co2Per100Km, 11.55);
    assert.equal(data.energy.teams['1'].score, null);
  });

  it('calculates a numeric score after the energy total is entered in the score table', async () => {
    const scoringYear = 2087;
    for (const field of ['driver1_time', 'driver2_time']) {
      const timeUpdate = await client.put('/api/score/endurance', {
        cookie: adminCookie,
        body: { year: scoringYear, team_num: 1, field, value: 50_000 },
      });
      assert.equal(timeUpdate.status, 200);
    }

    const update = await client.put('/api/score/setting', {
      cookie: adminCookie,
      body: { year: scoringYear, event_type: '에너지', setting_key: 'total', value: 50 },
    });
    assert.equal(update.status, 200);

    const res = await client.get(`/api/score?year=${scoringYear}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.settings['에너지'].total, 50);
    assert.equal(data.energy.teams['1'].status, 'SCORED');
    assert.equal(data.energy.teams['1'].score, 50);
  });
});

// ─── Auth ───────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('allows master and rejects chief on protected score APIs', async () => {
    assert.equal((await client.get('/api/score?year=2026', { cookie: masterCookie })).status, 200);
    assert.equal((await client.get('/api/score?year=2026', { cookie: chiefCookie })).status, 403);
    assert.equal((await client.get('/api/logs', { cookie: masterCookie })).status, 403);
  });

  it('PUT /api/score/manual without auth returns 401', async () => {
    const res = await client.put('/api/score/manual', {
      body: { year: 2026, team_num: 1, score_type: 'report', value: 50 },
    });
    assert.equal(res.status, 401);
  });

  it('keeps the full score aggregation private', async () => {
    const res = await client.get('/api/score?year=2026');
    assert.equal(res.status, 401);
  });
});

// ─── Public score publication ───────────────────────────────────────────

describe('Public score publication', () => {
  it('defaults to private and protects publication settings', async () => {
    const unauthenticated = await client.get('/api/score/publication?year=2026');
    assert.equal(unauthenticated.status, 401);

    const state = await client.get('/api/score/publication?year=2026', { cookie: adminCookie });
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { year: 2026, enabled: false });

    const publicData = await client.get('/api/score/public/2026');
    assert.equal(publicData.status, 404);

    const publicPage = await client.get('/public/2026');
    assert.equal(publicPage.status, 404);
  });

  it('validates publication updates', async () => {
    const badYear = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 1999, enabled: true },
    });
    assert.equal(badYear.status, 400);

    const badEnabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: 1 },
    });
    assert.equal(badEnabled.status, 400);
  });

  it('serves only the public table fields while enabled', async () => {
    const enabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: true },
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { year: 2026, enabled: true });

    mockEntryRequestCount = 0;
    const res = await client.get('/api/score/public/2026');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.year, 2026);
    assert.deepEqual(Object.keys(data).sort(), ['entries', 'events', 'year']);
    assert.deepEqual(data.entries['1'], { univ: '서울대', team: '팀A', type: 'EV' });
    assert.equal(data.events.some((event) => event.type === '내구'), false);
    assert.ok(data.events.some((event) => event.type === '가속'));
    assert.deepEqual(Object.keys(data.events.find((event) => event.type === '가속').records['1']), ['result', 'status']);

    const cached = await client.get('/api/score/public/2026');
    assert.equal(cached.status, 200);
    assert.equal(mockEntryRequestCount, 1, 'sequential public requests should reuse the short-lived snapshot');
  });

  it('publishes refresh notifications over the public SSE stream', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/score/public/2026/events`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.headers.get('content-type')?.includes('text/event-stream'));

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    assert.match(initial, /event: init/);

    const update = await client.put('/api/score/penalty', {
      cookie: adminCookie,
      body: { year: 2026, event_type: '가속', cone_penalty: 3, oc_penalty: 10, start_delay: 0 },
    });
    assert.equal(update.status, 200);

    let message = '';
    await Promise.race([
      (async () => {
        while (!message.includes('event: refresh')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          message += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('public SSE refresh timeout')), 2000)),
    ]);
    assert.match(message, /event: refresh/);

    const refreshed = await client.get('/api/score/public/2026');
    assert.equal(refreshed.status, 200);
    assert.equal(mockEntryRequestCount, 2, 'score updates should invalidate the public snapshot');
    await reader.cancel();
    controller.abort();
  });

  it('blocks public data again immediately after publication is disabled', async () => {
    const disabled = await client.put('/api/score/publication', {
      cookie: adminCookie,
      body: { year: 2026, enabled: false },
    });
    assert.equal(disabled.status, 200);

    const publicData = await client.get('/api/score/public/2026');
    assert.equal(publicData.status, 404);
    const publicEvents = await client.get('/api/score/public/2026/events');
    assert.equal(publicEvents.status, 404);
  });
});

// ─── Score aggregation business logic ────────────────────────────────────

describe('Score aggregation business logic', () => {
  let srv, url, cli, database, dp;
  const cookie = adminCookie;
  const YEAR = currentCompetitionYear();

  before(async () => {
    dp = tmpDbPath();
    const result = createScoreApp({
      dbPath: dp,
      skipSSESubscriptions: true,
      validateUser: TRUST_JWT,
      competitionQueries: createCompetitionQueries({ rich: true }),
    });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);
  });

  after(async () => {
    await stopServer(srv);
    database.close();
    cleanup(dp);
  });

  it('extracts corner weight data from inspection template', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.inspection.cornerWeight, 'cornerWeight should be present');
    assert.equal(data.inspection.cornerWeight.categoryId, 100);
    assert.ok(data.inspection.cornerWeight.items.curb, 'curb item ID should be set');
    assert.ok(data.inspection.cornerWeight.teams[1], 'team 1 corner weight data should exist');
    assert.equal(data.inspection.cornerWeight.teams[1].curb, '250');
    assert.equal(data.inspection.cornerWeight.teams[1].fl, '63');
    assert.equal(data.inspection.cornerWeight.teams[1].rr, '61');
  });

  it('merges records from multiple tables for same event type', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    assert.ok(accel, '가속 event should exist');

    // Team 1 has runs from both 가속 1차 and 가속 2차
    assert.ok(accel.records[1], 'team 1 should have records');
    assert.ok(accel.records[1].allRuns.length >= 2, 'team 1 should have runs from multiple tables');
  });

  it('keeps the most recent DSQ when no normal finish exists', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 2: the newer DSQ wins over an older DNF, while a later DNS is ignored;
    // raw measured times and every status stay in allRuns.
    assert.ok(accel.records[2], 'team 2 should exist');
    assert.equal(accel.records[2].result, null);
    assert.equal(accel.records[2].status, 'DSQ');
    assert.deepEqual(accel.records[2].allRuns.map((run) => run.result), [48000, 49000, null]);
  });

  it('all-DNF runs produce an explicit DNF without a result sentinel', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 3: both runs are DNF.
    assert.ok(accel.records[3], 'team 3 should exist');
    assert.equal(accel.records[3].result, null);
    assert.equal(accel.records[3].status, 'DNF');
  });

  it('all-DNS runs produce DNS with no scoreable result', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    assert.ok(accel.records[4], 'team 4 should exist');
    assert.equal(accel.records[4].result, null);
    assert.equal(accel.records[4].status, 'DNS');
  });

  it('excludes disabled event modes from events', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const types = data.events.map(e => e.type);
    assert.ok(types.includes('가속'), '가속 (enabled) should be in events');
    assert.ok(!types.includes('스키드패드'), '스키드패드 (disabled) should NOT be in events');
    // 오토크로스 is enabled but has no records - should still appear with empty records
    assert.ok(types.includes('오토크로스'), '오토크로스 (enabled, no records) should be in events');
  });

  it('selects best run from merged multi-table records with penalty', async () => {
    // Set up penalty for 가속
    await cli.put('/api/score/penalty', {
      cookie,
      body: { year: YEAR, event_type: '가속', cone_penalty: 2, oc_penalty: 10, start_delay: 0 },
    });

    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    // Team 1: run1 = 50000 + 1*2*1000 = 52000, run2 = 55000 + 0 = 55000
    // Best = run1 (lower adjusted time)
    assert.equal(accel.records[1].result, 50000, 'best run from 가속 1차 should be selected');
    assert.equal(accel.records[1].cones, 1, 'best run cones should be from selected run');
  });
});

describe('Skidpad scoring time aggregation', () => {
  let srv, url, cli, database, dp;
  const cookie = adminCookie;
  const YEAR = currentCompetitionYear();

  before(async () => {
    dp = tmpDbPath();
    const competitionQueries = createCompetitionQueries({
      records: (year) => [{
        name: `FSK ${year} 스키드패드`,
        records: [
          { rowid: 1, time: '2026-01-01T10:00:00Z', num: 1, univ: 'A', team: 'A', type: '스키드패드', result: 20_000, status: null, cones: 2, oc: 0, scoreboard: 1 },
          { rowid: 2, time: '2026-01-01T10:05:00Z', num: 1, univ: 'A', team: 'A', type: '스키드패드', result: 21_000, status: null, cones: 0, oc: 0, scoreboard: 1 },
          { rowid: 3, time: '2026-01-01T10:10:00Z', num: 2, univ: 'B', team: 'B', type: '스키드패드', result: 18_000, status: null, cones: 0, oc: 0, scoreboard: 1 },
        ],
      }],
      modes: [{ event_type: '스키드패드', enabled: 1 }],
    });
    const result = createScoreApp({
      dbPath: dp,
      skipSSESubscriptions: true,
      validateUser: TRUST_JWT,
      competitionQueries,
    });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server;
    url = started.baseUrl;
    cli = createClient(url);

    const penalty = await cli.put('/api/score/penalty', {
      cookie,
      body: { year: YEAR, event_type: '스키드패드', cone_penalty: 0.3, oc_penalty: 0, start_delay: 0 },
    });
    assert.equal(penalty.status, 200);
  });

  after(async () => {
    await stopServer(srv);
    database.close();
    cleanup(dp);
  });

  it('selects the best run from the lap average plus all cone penalties', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const skidpad = data.events.find((event) => event.type === '스키드패드');

    // Run 1: 20,000 / 2 + 2 * 300 = 10,600 ms
    // Run 2: 21,000 / 2 = 10,500 ms, so run 2 is the regulatory best.
    assert.equal(skidpad.records[1].result, 21_000);
    assert.equal(skidpad.records[1].cones, 0);
  });

  it('publishes the skidpad lap average instead of the measured lap sum', async () => {
    const enabled = await cli.put('/api/score/publication', {
      cookie,
      body: { year: YEAR, enabled: true },
    });
    assert.equal(enabled.status, 200);

    const res = await cli.get(`/api/score/public/${YEAR}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const skidpad = data.events.find((event) => event.type === '스키드패드');

    assert.deepEqual(skidpad.records['1'], { result: 10_500, status: null });
    assert.deepEqual(skidpad.records['2'], { result: 9_000, status: null });
  });
});

// ─── Record visibility filtering ──────────────────────────────────────

// NOTE: record-visibility 제외 자체(숨긴 테이블을 빼는 것)는 이제 traffic
// getYearRecordGroups가 담당하며 tests/traffic/traffic.test.mjs에서 직접 검증한다.
// 여기서는 score가 traffic year 응답(이미 필터된 상태)을 그대로 받아 종목별로
// pass-through 집계하는지만 확인한다 — mock은 필터된 결과(가속 1차만)를 반환한다.
describe('Score aggregation over the pre-filtered traffic year response', () => {
  let srv, url, cli, database, dp;
  const cookie = adminCookie;
  const YEAR = currentCompetitionYear();

  before(async () => {
    dp = tmpDbPath();
    const competitionQueries = createCompetitionQueries({
      records: (year) => [{
        name: `FSK ${year} 가속 1차`,
        records: [{ rowid: 1, time: 'T1', num: 1, univ: 'A', team: 'A', type: '가속', result: 50000, status: null, cones: 0, oc: 0, scoreboard: 1 }],
      }],
      modes: [{ event_type: '가속', enabled: 1 }],
    });
    const result = createScoreApp({
      dbPath: dp,
      skipSSESubscriptions: true,
      validateUser: TRUST_JWT,
      competitionQueries,
    });
    database = result.db;
    const started = await startServer(result.app);
    srv = started.server; url = started.baseUrl;
    cli = createClient(url);
  });

  after(async () => {
    await stopServer(srv);
    database.close();
    cleanup(dp);
  });

  it('aggregates only the tables present in the traffic year response', async () => {
    const res = await cli.get(`/api/score?year=${YEAR}`, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();

    const accel = data.events.find(e => e.type === '가속');
    assert.ok(accel, '가속 event should exist');
    // traffic이 가속 1차(50000)만 돌려주므로 그 하나만 집계되어야 한다
    // (실제 숨김 필터링 검증은 tests/traffic/traffic.test.mjs).
    assert.equal(accel.records[1].result, 50000, 'should aggregate the single returned run');
    assert.equal(accel.records[1].allRuns.length, 1, 'no extra runs should appear');
  });
});

// ─── Internal API: entry lifecycle ──────────────────────────────────────
