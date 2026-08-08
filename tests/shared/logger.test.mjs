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
