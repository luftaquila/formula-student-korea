import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../../auth/node_modules/better-sqlite3');

process.env.INTERNAL_SECRET = 'test-secret';

import { createLogger } from '../../shared/logger.mjs';

function mockReq(query = {}, user = null, headers = {}) {
  return { query, user, headers, ip: '127.0.0.1' };
}

function mockRes() {
  let statusCode = 200;
  let body = null;
  return {
    status(code) { statusCode = code; return this; },
    send(data) { body = data; },
    json(data) { body = data; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

describe('createLogger', () => {
  let db, logger;

  before(() => {
    db = new Database(':memory:');
    logger = createLogger(db, 'test-service', 5);
  });

  it('creates logs table automatically', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'")
      .all();
    assert.equal(tables.length, 1);
    assert.equal(tables[0].name, 'logs');
  });

  it('log() writes info level record', () => {
    const req = mockReq({}, { email: 'admin@test.com', name: 'Admin', role: 'admin' });
    logger.log(req, 'test_action', 'some detail', 'target1');

    const row = db.prepare("SELECT * FROM logs WHERE action = 'test_action'").get();
    assert.ok(row);
    assert.equal(row.level, 'info');
    assert.equal(row.action, 'test_action');
    assert.equal(row.actor_email, 'admin@test.com');
    assert.equal(row.target, 'target1');
    assert.equal(row.detail, 'some detail');
  });

  it('warn() writes warn level record', () => {
    const req = mockReq({}, { email: 'admin@test.com', name: 'Admin', role: 'admin' });
    logger.warn(req, 'warn_action', { key: 'value' }, 'target2');

    const row = db.prepare("SELECT * FROM logs WHERE action = 'warn_action'").get();
    assert.ok(row);
    assert.equal(row.level, 'warn');
    assert.equal(row.detail, '{"key":"value"}');
  });

  it('queryHandler returns logs for admin user', () => {
    const req = mockReq({}, { email: 'admin@test.com', name: 'Admin', role: 'admin' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.ok(res.body);
    assert.ok(Array.isArray(res.body.logs));
    assert.ok(res.body.total >= 2);
    assert.equal(res.body.service, 'test-service');
  });

  it('queryHandler returns logs for internal service header', () => {
    const req = mockReq({}, null, { 'x-internal-service': 'test-secret' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.ok(res.body);
    assert.ok(Array.isArray(res.body.logs));
  });

  it('queryHandler returns 403 for non-admin', () => {
    const req = mockReq({}, { email: 'user@test.com', name: 'User', role: 'student' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.equal(res.statusCode, 403);
  });

  it('queryHandler filters by level', () => {
    const req = mockReq({ level: 'warn' }, { role: 'admin' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.ok(res.body.logs.length >= 1);
    for (const log of res.body.logs) {
      assert.equal(log.level, 'warn');
    }
  });

  it('queryHandler filters by action and actor', () => {
    const req = mockReq({ action: 'test_action', actor: 'admin' }, { role: 'admin' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.ok(res.body.logs.length >= 1);
    for (const log of res.body.logs) {
      assert.ok(log.action.startsWith('test_action'));
    }
  });

  it('queryHandler supports pagination (limit, offset)', () => {
    const req = mockReq({ limit: '1', offset: '0' }, { role: 'admin' });
    const res = mockRes();
    logger.queryHandler(req, res);

    assert.equal(res.body.logs.length, 1);
    assert.ok(res.body.total >= 2);
  });

  it('queryHandler exposes nextCursor/hasMore and a before-cursor returns strictly older rows', () => {
    const curDb = new Database(':memory:');
    const curLogger = createLogger(curDb, 'cursor-test');
    const insert = curDb.prepare("INSERT INTO logs (timestamp, module, level, action) VALUES (?, 'cursor-test', 'info', ?)");
    // 동일 timestamp 3행(id로 갈라야 함) + 더 오래된 1행
    insert.run('2026-03-01T00:00:01.000Z', 'same_a');
    insert.run('2026-03-01T00:00:01.000Z', 'same_b');
    insert.run('2026-03-01T00:00:01.000Z', 'same_c');
    insert.run('2026-03-01T00:00:00.000Z', 'older');

    const res1 = mockRes();
    curLogger.queryHandler(mockReq({ limit: '2' }, { role: 'admin' }), res1);
    assert.equal(res1.body.logs.length, 2);
    assert.equal(res1.body.hasMore, true);
    assert.ok(res1.body.nextCursor);
    // 최신 정렬: same_c(id 3), same_b(id 2)
    assert.deepEqual(res1.body.logs.map(l => l.action), ['same_c', 'same_b']);

    const res2 = mockRes();
    curLogger.queryHandler(mockReq({ limit: '2', before: res1.body.nextCursor }, { role: 'admin' }), res2);
    assert.deepEqual(res2.body.logs.map(l => l.action), ['same_a', 'older']);
    // 남은 행이 정확히 limit개였으므로 다음 페이지는 없다 (limit+1 판정)
    assert.equal(res2.body.hasMore, false);

    curDb.close();
  });

  it('queryHandler combines before-cursor with filters', () => {
    const curDb = new Database(':memory:');
    const curLogger = createLogger(curDb, 'cursor-filter-test');
    const insert = curDb.prepare("INSERT INTO logs (timestamp, module, level, action) VALUES (?, 'cursor-filter-test', ?, ?)");
    insert.run('2026-03-01T00:00:03.000Z', 'warn', 'w1');
    insert.run('2026-03-01T00:00:02.000Z', 'info', 'i1');
    insert.run('2026-03-01T00:00:01.000Z', 'warn', 'w2');

    const res1 = mockRes();
    curLogger.queryHandler(mockReq({ limit: '1', level: 'warn' }, { role: 'admin' }), res1);
    assert.deepEqual(res1.body.logs.map(l => l.action), ['w1']);

    const res2 = mockRes();
    curLogger.queryHandler(mockReq({ limit: '1', level: 'warn', before: res1.body.nextCursor }, { role: 'admin' }), res2);
    assert.deepEqual(res2.body.logs.map(l => l.action), ['w2']);

    curDb.close();
  });

  it('queryHandler silently falls back to page 1 on a malformed before-cursor', () => {
    const res = mockRes();
    logger.queryHandler(mockReq({ limit: '1', before: 'garbage-no-comma' }, { role: 'admin' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.logs.length, 1);
  });

  // 회귀: 정확히 limit개가 매칭되면 다음 페이지가 없다 — logs.length === limit 휴리스틱은
  // 이 경우를 "다음 페이지 있음"으로 오판해 빈 2페이지를 만들었다. limit+1 조회로 판정한다.
  it('queryHandler reports hasMore=false when the result set is exactly limit rows', () => {
    const exactDb = new Database(':memory:');
    const exactLogger = createLogger(exactDb, 'exact-test');
    const insert = exactDb.prepare("INSERT INTO logs (timestamp, module, level, action) VALUES (?, 'exact-test', 'info', ?)");
    insert.run('2026-03-01T00:00:01.000Z', 'row_a');
    insert.run('2026-03-01T00:00:02.000Z', 'row_b');

    const res = mockRes();
    exactLogger.queryHandler(mockReq({ limit: '2' }, { role: 'admin' }), res);
    assert.equal(res.body.logs.length, 2);
    assert.equal(res.body.hasMore, false, 'exactly-limit rows must not promise another page');
    assert.equal(res.body.nextCursor, null);

    // 커서 페이지의 마지막 장도 동일: 첫 페이지(limit 1) 뒤에 딱 1행 남은 경우
    const res1 = mockRes();
    exactLogger.queryHandler(mockReq({ limit: '1' }, { role: 'admin' }), res1);
    assert.equal(res1.body.hasMore, true, 'a genuine extra row still reports hasMore');
    const res2 = mockRes();
    exactLogger.queryHandler(mockReq({ limit: '1', before: res1.body.nextCursor }, { role: 'admin' }), res2);
    assert.equal(res2.body.logs.length, 1);
    assert.equal(res2.body.hasMore, false, 'the final cursor page must close pagination');
    assert.equal(res2.body.nextCursor, null);

    exactDb.close();
  });

  // 보존은 AFTER INSERT 트리거(setupRowCapRetention)라 삽입 즉시 적용된다 — 타이머 없음.
  it('row-cap retention keeps only the newest maxRows rows as inserts happen', () => {
    const cleanDb = new Database(':memory:');
    const cleanLogger = createLogger(cleanDb, 'clean-test', 5);

    for (let i = 0; i < 10; i++) {
      cleanLogger.log(null, `action_${i}`, `detail_${i}`);
    }

    const count = cleanDb.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt;
    assert.equal(count, 5);

    const remaining = cleanDb.prepare('SELECT action FROM logs ORDER BY id ASC').all();
    assert.equal(remaining[0].action, 'action_5');
    assert.equal(remaining[4].action, 'action_9');

    cleanDb.close();
  });

  it('row-cap retention trims pre-existing overflow at logger creation', () => {
    const preDb = new Database(':memory:');
    const first = createLogger(preDb, 'pre-test', 50000);
    for (let i = 0; i < 10; i++) first.log(null, `old_${i}`, null);
    createLogger(preDb, 'pre-test', 5); // 재생성 시 낮아진 cap으로 초기 catch-up
    const count = preDb.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt;
    assert.equal(count, 5);
    preDb.close();
  });

  it('applies the row cap independently to each module in a shared database', () => {
    const sharedDb = new Database(':memory:');
    const entryLogger = createLogger(sharedDb, 'entry', 2);
    const trafficLogger = createLogger(sharedDb, 'traffic', 2);

    for (let i = 0; i < 3; i++) {
      entryLogger.log(null, `entry_${i}`, null);
      trafficLogger.log(null, `traffic_${i}`, null);
    }

    assert.deepEqual(sharedDb.prepare(`
      SELECT module, COUNT(*) AS count FROM logs GROUP BY module ORDER BY module
    `).all(), [
      { module: 'entry', count: 2 },
      { module: 'traffic', count: 2 },
    ]);
    assert.deepEqual(sharedDb.prepare(
      "SELECT action FROM logs WHERE module = 'entry' ORDER BY id",
    ).all().map((row) => row.action), ['entry_1', 'entry_2']);
    assert.deepEqual(sharedDb.prepare(
      "SELECT action FROM logs WHERE module = 'traffic' ORDER BY id",
    ).all().map((row) => row.action), ['traffic_1', 'traffic_2']);

    sharedDb.close();
  });
});

import { buildLogFilter } from '../../shared/logger.mjs';

describe('buildLogFilter', () => {
  it('returns empty WHERE for no filters', () => {
    assert.deepEqual(buildLogFilter({}), { where: '', params: [] });
  });

  it('builds level IN clause from comma-separated values', () => {
    const { where, params } = buildLogFilter({ level: 'info,warn' });
    assert.match(where, /level IN \(\?,\?\)/);
    assert.deepEqual(params, ['info', 'warn']);
  });

  it('coerces repeated query params (arrays) instead of throwing', () => {
    const { where, params } = buildLogFilter({ level: ['info', 'warn'], action: ['a.b'] });
    assert.match(where, /level IN/);
    assert.deepEqual(params.slice(0, 2), ['info', 'warn']);
    assert.ok(params.includes('a.b%'));
  });

  it('combines action/actor/from/to/search filters', () => {
    const { where, params } = buildLogFilter({
      action: 'entry', actor: 'kim', from: '2026-01-01', to: '2026-12-31', search: 'x',
    });
    assert.match(where, /action LIKE \?/);
    assert.match(where, /actor_email LIKE \? OR actor_name LIKE \?/);
    assert.match(where, /timestamp >= \?/);
    assert.match(where, /timestamp <= \?/);
    assert.equal(params.length, 8);
  });
});
