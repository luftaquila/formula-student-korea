import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatPhone, displayPhone } from '../../shared/format-phone.js';

describe('formatPhone', () => {
  it('returns empty string for empty input', () => {
    assert.equal(formatPhone(''), '');
  });

  it('returns digits as-is for 3 or fewer digits', () => {
    assert.equal(formatPhone('0'), '0');
    assert.equal(formatPhone('01'), '01');
    assert.equal(formatPhone('010'), '010');
  });

  it('formats 4-7 digits as XXX-XXXX', () => {
    assert.equal(formatPhone('0101'), '010-1');
    assert.equal(formatPhone('01012'), '010-12');
    assert.equal(formatPhone('010123'), '010-123');
    assert.equal(formatPhone('0101234'), '010-1234');
  });

  it('formats 8-11 digits as XXX-XXXX-XXXX', () => {
    assert.equal(formatPhone('01012345'), '010-1234-5');
    assert.equal(formatPhone('0101234567'), '010-1234-567');
    assert.equal(formatPhone('01012345678'), '010-1234-5678');
  });

  it('strips non-digit characters', () => {
    assert.equal(formatPhone('010-1234-5678'), '010-1234-5678');
    assert.equal(formatPhone('abc010def1234ghi5678'), '010-1234-5678');
    assert.equal(formatPhone('+82 10 1234 5678'), '821-0123-4567');
  });

  it('truncates to 11 digits maximum', () => {
    assert.equal(formatPhone('010123456789999'), '010-1234-5678');
  });
});

describe('displayPhone', () => {
  it('formats 11-digit phone number with hyphens', () => {
    assert.equal(displayPhone('01012345678'), '010-1234-5678');
  });

  it('returns short input as-is when regex does not match', () => {
    assert.equal(displayPhone('0101234'), '0101234');
  });

  it('returns already-formatted input unchanged if no 11-digit run', () => {
    assert.equal(displayPhone('010-1234-5678'), '010-1234-5678');
  });
});
