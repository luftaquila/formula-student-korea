import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ROLE_LEVELS, EVENT_TYPES } from '../../shared/constants.js';
import { VALID_ROLES } from '../../shared/express-setup.mjs';

describe('ROLE_LEVELS', () => {
  it('has exactly four keys', () => {
    assert.equal(Object.keys(ROLE_LEVELS).length, 4);
  });

  it('student level is 1', () => {
    assert.equal(ROLE_LEVELS.student, 1);
  });

  it('official level is 2', () => {
    assert.equal(ROLE_LEVELS.official, 2);
  });

  it('chief level is 3', () => {
    assert.equal(ROLE_LEVELS.chief, 3);
  });

  it('admin level is 4', () => {
    assert.equal(ROLE_LEVELS.admin, 4);
  });
});

describe('EVENT_TYPES', () => {
  it('has exactly four event types', () => {
    assert.equal(EVENT_TYPES.length, 4);
  });

  it('contains the correct event names in order', () => {
    assert.deepEqual(EVENT_TYPES, ['가속', '스키드패드', '오토크로스', '짐카나']);
  });
});

describe('VALID_ROLES', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(VALID_ROLES));
  });

  it('contains exactly student, official, chief, admin', () => {
    assert.deepEqual(VALID_ROLES, ['student', 'official', 'chief', 'admin']);
  });
});
