import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balancedRowSizes } from '../../landing/src/balanced-rows.js';

describe('landing menu row distribution', () => {
  it('balances overflow across rows with at most six cards each', () => {
    for (const [count, expected] of [
      [0, []], [1, [1]], [6, [6]], [7, [4, 3]], [8, [4, 4]],
      [10, [5, 5]], [12, [6, 6]], [13, [5, 4, 4]], [19, [5, 5, 5, 4]],
    ]) {
      assert.deepEqual(balancedRowSizes(count, 6), expected);
    }
  });

  it('uses the fewest rows and keeps row counts balanced at every screen capacity', () => {
    for (let capacity = 1; capacity <= 6; capacity++) {
      for (let count = 1; count <= 100; count++) {
        const rows = balancedRowSizes(count, capacity);
        assert.equal(rows.length, Math.ceil(count / capacity));
        assert.equal(rows.reduce((sum, size) => sum + size, 0), count);
        assert.ok(rows.every(size => size >= 1 && size <= capacity));
        assert.ok(Math.max(...rows) - Math.min(...rows) <= 1);
        assert.deepEqual(rows, [...rows].sort((a, b) => b - a));
      }
    }
  });
});
