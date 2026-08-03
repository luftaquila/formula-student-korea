import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getChecktableConfig,
  hasCheckedChecktableCell,
  nextCounterValue,
  normalizeCounterInput,
  formatStopwatchElapsed,
  isResponseItem,
  isPdfItem,
} from '../../inspection/web/src/utils/sheet-helpers.js';

const item = {
  remarks: JSON.stringify({
    rows: ['First row'],
    columns: ['First column'],
  }),
};

describe('Check-table completion', () => {
  it('accepts a checked cell that exists in the current configuration', () => {
    assert.equal(hasCheckedChecktableCell(item, { '0_0': '1' }), true);
  });

  it('ignores checked cells removed from the current configuration', () => {
    assert.equal(hasCheckedChecktableCell(item, { '1_1': '1', '99_99': '1' }), false);
  });

  it('accepts one current checked cell when stale values are also stored', () => {
    assert.equal(hasCheckedChecktableCell(item, { '0_0': '1', '1_1': '1' }), true);
  });
});

describe('Check-table configuration', () => {
  it('normalizes a non-array row value while preserving valid columns', () => {
    const malformedItem = {
      remarks: JSON.stringify({ rows: 'not-an-array', columns: ['First column'] }),
    };
    const config = getChecktableConfig(malformedItem);

    assert.deepEqual(config, { rows: [], columns: ['First column'] });
    assert.equal(hasCheckedChecktableCell(malformedItem, { '0_0': '1' }), false);
  });

  it('normalizes a non-array column value while preserving valid rows', () => {
    const config = getChecktableConfig({
      remarks: JSON.stringify({ rows: ['First row'], columns: { first: 'First column' } }),
    });

    assert.deepEqual(config, { rows: ['First row'], columns: [] });
  });

  it('returns an empty configuration for malformed JSON', () => {
    assert.deepEqual(getChecktableConfig({ remarks: '{' }), { rows: [], columns: [] });
  });
});

describe('Counter values', () => {
  it('increments an empty value from zero', () => {
    assert.equal(nextCounterValue('', 1), '1');
  });

  it('does not decrement below zero', () => {
    assert.equal(nextCounterValue('0', -1), '0');
  });

  it('normalizes malformed and fractional values', () => {
    assert.equal(nextCounterValue('invalid', 1), '1');
    assert.equal(nextCounterValue('2.9', 1), '3');
  });

  it('accepts direct non-negative integer input and removes leading zeros', () => {
    assert.equal(normalizeCounterInput('12'), '12');
    assert.equal(normalizeCounterInput('0012'), '12');
    assert.equal(normalizeCounterInput(''), '');
  });

  it('rejects negative, fractional, and non-numeric direct input', () => {
    assert.equal(normalizeCounterInput('-1'), null);
    assert.equal(normalizeCounterInput('1.5'), null);
    assert.equal(normalizeCounterInput('one'), null);
  });
});

describe('Stopwatch display', () => {
  it('formats all milliseconds without an hour for short durations', () => {
    assert.equal(formatStopwatchElapsed(62_349), '01:02.349');
  });

  it('includes hours for long durations', () => {
    assert.equal(formatStopwatchElapsed(3_661_999), '01:01:01.999');
  });

  it('normalizes invalid or negative durations to zero', () => {
    assert.equal(formatStopwatchElapsed(-100), '00:00.000');
    assert.equal(formatStopwatchElapsed('invalid'), '00:00.000');
  });
});

describe('Non-response field rules', () => {
  const stopwatch = { answer_type: 'stopwatch' };

  it('excludes stopwatches from response completion', () => {
    assert.equal(isResponseItem(stopwatch), false);
    assert.equal(isResponseItem({ answer_type: 'counter' }), true);
  });

  it('excludes stopwatches but keeps counters in PDF output', () => {
    assert.equal(isPdfItem(stopwatch), false);
    assert.equal(isPdfItem({ answer_type: 'counter' }), true);
  });
});
