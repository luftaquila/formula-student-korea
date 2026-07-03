import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateEntryNum } from '../../shared/validation.mjs';

describe('validateEntryNum', () => {
  it('accepts positive integers (number or numeric string)', () => {
    assert.deepEqual(validateEntryNum(1), { valid: true, value: 1 });
    assert.deepEqual(validateEntryNum(123), { valid: true, value: 123 });
    assert.deepEqual(validateEntryNum('42'), { valid: true, value: 42 });
  });

  it('rejects empty / undefined / null', () => {
    assert.equal(validateEntryNum('').valid, false);
    assert.equal(validateEntryNum(undefined).valid, false);
    assert.equal(validateEntryNum(null).valid, false);
  });

  it('rejects non-numeric values', () => {
    assert.equal(validateEntryNum('abc').valid, false);
    assert.equal(validateEntryNum('12a').valid, false);
    assert.equal(validateEntryNum(NaN).valid, false);
  });

  it('rejects zero and negatives', () => {
    assert.equal(validateEntryNum(0).valid, false);
    assert.equal(validateEntryNum(-1).valid, false);
    assert.equal(validateEntryNum('-5').valid, false);
  });

  it('rejects non-integers', () => {
    assert.equal(validateEntryNum(1.5).valid, false);
    assert.equal(validateEntryNum('2.7').valid, false);
  });

  it('returns the Korean error message on invalid input', () => {
    assert.equal(validateEntryNum('').error, '올바르지 않은 엔트리 번호입니다.');
  });
});

import { validateYear } from '../../shared/validation.mjs';

describe('validateYear', () => {
  it('accepts years 2000-2099 (number or numeric string)', () => {
    assert.deepEqual(validateYear(2026), { valid: true, value: 2026 });
    assert.deepEqual(validateYear('2000'), { valid: true, value: 2000 });
    assert.deepEqual(validateYear(2099), { valid: true, value: 2099 });
  });

  it('rejects out-of-range years', () => {
    assert.equal(validateYear(1999).valid, false);
    assert.equal(validateYear(2100).valid, false);
  });

  it('rejects empty / null / undefined / non-numeric / non-integer', () => {
    assert.equal(validateYear('').valid, false);
    assert.equal(validateYear(null).valid, false);
    assert.equal(validateYear(undefined).valid, false);
    assert.equal(validateYear('abc').valid, false);
    assert.equal(validateYear(2026.5).valid, false);
  });
});
