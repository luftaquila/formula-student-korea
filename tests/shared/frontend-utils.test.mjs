import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDate, formatSize } from '../../shared/format-date.js';
import { createKeyedDebouncer } from '../../shared/debounce.js';

describe('formatDate', () => {
  it('formats valid DB timestamps to a locale string', () => {
    const out = formatDate('2026-07-01T03:00:00.000Z');
    assert.notEqual(out, '-');
    assert.ok(out.length > 0);
  });

  it('returns "-" for empty or invalid values', () => {
    assert.equal(formatDate(''), '-');
    assert.equal(formatDate(null), '-');
    assert.equal(formatDate('not-a-date'), '-');
  });
});

describe('formatSize', () => {
  it('formats byte sizes with units', () => {
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
  });

  it('returns "-" for zero/empty', () => {
    assert.equal(formatSize(0), '-');
    assert.equal(formatSize(null), '-');
  });
});

describe('createKeyedDebouncer', () => {
  it('runs only the last fn per key after the delay', async () => {
    const { debounce } = createKeyedDebouncer(10);
    const calls = [];
    debounce('k', () => calls.push('first'));
    debounce('k', () => calls.push('second'));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(calls, ['second']);
  });

  it('flush() runs pending fns immediately, exactly once', async () => {
    const { debounce, flush } = createKeyedDebouncer(10_000);
    const calls = [];
    debounce('a', () => calls.push('a'));
    debounce('b', () => calls.push('b'));
    flush();
    assert.deepEqual(calls.sort(), ['a', 'b']);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 2); // 타이머가 취소되어 재실행 없음
  });

  it('cancel(key) discards without running', async () => {
    const { debounce, cancel, flush } = createKeyedDebouncer(10_000);
    const calls = [];
    debounce('a', () => calls.push('a'));
    cancel('a');
    flush();
    assert.deepEqual(calls, []);
  });
});
