import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getChecktableConfig,
  hasCheckedChecktableCell,
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
