import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { serviceUrl, logAggregationTargets } from '../../shared/services.mjs';

const ENV_KEYS = ['ENTRY_SERVER', 'AUTH_SERVER', 'QUEUE_SERVER'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('serviceUrl', () => {
  it('returns the registry constant when no override is set', () => {
    assert.equal(serviceUrl('entry'), 'http://entry:9200');
    assert.equal(serviceUrl('auth'), 'http://auth:9100');
    assert.equal(serviceUrl('calendar'), 'http://calendar:11000');
  });

  it('lets <NAME>_SERVER override the constant', () => {
    process.env.ENTRY_SERVER = 'http://127.0.0.1:45678';
    assert.equal(serviceUrl('entry'), 'http://127.0.0.1:45678');
    assert.equal(serviceUrl('auth'), 'http://auth:9100', 'other services are unaffected');
  });

  // 테스트가 app 팩토리 호출 직전에 env를 세팅하므로, 모듈 로드 시점이 아니라
  // 호출 시점에 읽어야 한다.
  it('reads the override at call time, not at import time', () => {
    assert.equal(serviceUrl('queue'), 'http://queue:9300');
    process.env.QUEUE_SERVER = 'http://127.0.0.1:1';
    assert.equal(serviceUrl('queue'), 'http://127.0.0.1:1');
  });

  // `||` 폴백이므로 빈 문자열은 상수로 떨어진다. 빈 env가 "http:///api/..." 같은
  // 깨진 URL을 만들지 않아야 한다.
  it('falls back to the constant when the override is an empty string', () => {
    process.env.ENTRY_SERVER = '';
    assert.equal(serviceUrl('entry'), 'http://entry:9200');
  });

  it('throws on an unknown service name', () => {
    assert.throws(() => serviceUrl('nope'), /Unknown service: nope/);
  });
});

describe('logAggregationTargets', () => {
  // 손으로 관리하던 9개짜리 LOG_SERVICES 문자열을 대체했으므로, 그 집합이
  // 그대로인지 고정해 둔다.
  it('returns every service except auth', () => {
    const targets = logAggregationTargets();
    assert.deepEqual(Object.keys(targets).sort(), [
      'calendar', 'course', 'documents', 'email', 'entry',
      'inspection', 'queue', 'score', 'traffic',
    ]);
    assert.equal(targets.auth, undefined, 'auth queries its own DB locally');
    assert.equal(targets.entry, 'http://entry:9200');
  });

  it('honours overrides', () => {
    process.env.ENTRY_SERVER = 'http://127.0.0.1:45679';
    assert.equal(logAggregationTargets().entry, 'http://127.0.0.1:45679');
  });
});
