import assert from "node:assert/strict";
import test from "node:test";

import {
  addPendingKey,
  removePendingKey,
} from "../../competition/modules/queue/web/src/pending-last-calls.js";

test("finishing one last call preserves other pending entries", () => {
  const first = addPendingKey(new Set(), "battery-1");
  const both = addPendingKey(first, "battery-2");
  const remaining = removePendingKey(both, "battery-1");

  assert.deepEqual([...remaining], ["battery-2"]);
  assert.equal(addPendingKey(remaining, "battery-2"), remaining);
});
