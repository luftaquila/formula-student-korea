import assert from "node:assert/strict";
import test from "node:test";

import { formatBoothElapsed } from "../../queue/web/src/booth-timer.js";

test("booth timer freezes at the pause instant after subtracting earlier pauses", () => {
  const booth = {
    entered_at: 1_000,
    timer_paused_at: 9_000,
    timer_paused_ms: 3_000,
  };

  assert.equal(formatBoothElapsed(booth, 20_000), "00:05");
  assert.equal(formatBoothElapsed(booth, 40_000), "00:05");
});

test("booth timer continues from the frozen elapsed value after resume", () => {
  const booth = {
    entered_at: 1_000,
    timer_paused_at: null,
    timer_paused_ms: 8_000,
  };

  assert.equal(formatBoothElapsed(booth, 14_000), "00:05");
  assert.equal(formatBoothElapsed(booth, 15_000), "00:06");
});
