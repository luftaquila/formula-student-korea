import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { serviceUrl, logAggregationTargets, SERVICE_NAMES, RUNTIME_SERVICE_NAMES } from '../../shared/services.mjs';

const ENV_KEYS = ['AUTH_SERVER', 'COMPETITION_SERVER'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('serviceUrl', () => {
  it('returns the registry constant when no override is set', () => {
    assert.equal(serviceUrl('auth'), 'http://auth:9100');
    assert.equal(serviceUrl('calendar'), 'http://calendar:11000');
    assert.equal(serviceUrl('competition'), 'http://competition:9200');
  });

  it('lets <NAME>_SERVER override the constant', () => {
    process.env.AUTH_SERVER = 'http://127.0.0.1:45678';
    assert.equal(serviceUrl('auth'), 'http://127.0.0.1:45678');
    assert.equal(serviceUrl('calendar'), 'http://calendar:11000', 'other services are unaffected');
  });

  // 테스트가 app 팩토리 호출 직전에 env를 세팅하므로, 모듈 로드 시점이 아니라
  // 호출 시점에 읽어야 한다.
  it('reads the override at call time, not at import time', () => {
    assert.equal(serviceUrl('competition'), 'http://competition:9200');
    process.env.COMPETITION_SERVER = 'http://127.0.0.1:1';
    assert.equal(serviceUrl('competition'), 'http://127.0.0.1:1');
  });

  // `||` 폴백이므로 빈 문자열은 상수로 떨어진다. 빈 env가 "http:///api/..." 같은
  // 깨진 URL을 만들지 않아야 한다.
  it('falls back to the constant when the override is an empty string', () => {
    process.env.COMPETITION_SERVER = '';
    assert.equal(serviceUrl('competition'), 'http://competition:9200');
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
      'inspection', 'queue', 'registration', 'score', 'traffic',
    ]);
    assert.equal(targets.auth, undefined, 'auth queries its own DB locally');
    assert.equal(targets.entry, 'http://competition:9200/competition/api/v1/logs');
    assert.equal(targets.queue, 'http://competition:9200/competition/api/v1/queue/logs');
    assert.equal(targets.registration, 'http://competition:9200/competition/api/v1/registration/logs');
    assert.equal(targets.course, 'http://course:10000/api/logs');
  });

  // 로그 뷰어의 서비스 필터가 이 배열을 쓴다. 손으로 적은 목록을 대체했으므로,
  // 집계 대상과 어긋나지 않는지 고정한다.
  it('SERVICE_NAMES covers the aggregation targets plus auth', () => {
    assert.deepEqual(
      [...SERVICE_NAMES].sort(),
      ['auth', ...Object.keys(logAggregationTargets())].sort(),
    );
    assert.ok(SERVICE_NAMES.includes('auth'), 'the viewer filters auth too (queried locally)');
  });

  // 이름은 service-names.js, 포트는 services.mjs에 있다. 이름만 추가하면 URL이
  // "http://x:undefined"가 되므로 조용히 깨지지 않게 고정한다.
  it('every name resolves to a well-formed URL', () => {
    for (const name of RUNTIME_SERVICE_NAMES) {
      assert.match(serviceUrl(name), /^http:\/\/[a-z]+:\d+$/, `${name} must have a port`);
    }
  });

  it('has no standalone Competition module service addresses', () => {
    for (const name of ['entry', 'queue', 'registration', 'inspection', 'traffic', 'score', 'documents']) {
      assert.throws(() => serviceUrl(name), new RegExp(`Unknown service: ${name}`));
    }
  });

  // 브라우저 번들에 들어가는 배열이므로 컴포넌트가 넘겨받아 변형하지 못하게 한다.
  it('SERVICE_NAMES is frozen', () => {
    assert.ok(Object.isFrozen(SERVICE_NAMES));
  });

  it('honours overrides', () => {
    process.env.COMPETITION_SERVER = 'http://127.0.0.1:45679';
    assert.equal(logAggregationTargets().entry, 'http://127.0.0.1:45679/competition/api/v1/logs');
  });
});
