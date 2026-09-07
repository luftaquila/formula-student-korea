import assert from "node:assert/strict";
import test from "node:test";

import {
  isLookupEntryAvailable,
  isTerminalLookupError,
} from "../../queue/web/src/lookup-state.js";

test("terminal lookup errors distinguish invalid entries from transient failures", () => {
  for (const status of [400, 404, 410]) {
    assert.equal(isTerminalLookupError({ status }), true);
  }
  for (const status of [0, 429, 500, 503, undefined]) {
    assert.equal(isTerminalLookupError({ status }), false);
  }
});

test("lookup entries must still exist and remain active", () => {
  const entries = {
    1: { active: true },
    2: { active: false },
    3: {},
  };

  assert.equal(isLookupEntryAvailable(entries, "1"), true);
  assert.equal(isLookupEntryAvailable(entries, "2"), false);
  assert.equal(isLookupEntryAvailable(entries, "3"), true);
  assert.equal(isLookupEntryAvailable(entries, "4"), false);
});
