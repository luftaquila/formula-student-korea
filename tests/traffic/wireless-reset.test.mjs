import test from "node:test";
import assert from "node:assert/strict";
import {
  applyResetPendingMarker,
  createResetPendingMarker,
  resetPendingMarkerResolved,
} from "../../traffic/lib/wireless-reset.mjs";

const base = {
  event_type: "가속",
  run_id: "run-1",
  reset_pending: false,
  updated_at: "2026-08-25T06:00:00.100Z",
  controller: "admin@test.com#tab",
};

test("reset command response latches pending when its SSE event was missed", () => {
  const response = { ...base, reset_pending: true, updated_at: "2026-08-25T06:00:00.200Z" };
  const marker = createResetPendingMarker(base, response);

  assert.deepEqual(marker, { run_id: "run-1", updated_at: response.updated_at });
  assert.deepEqual(applyResetPendingMarker(base, marker), { ...base, reset_pending: true });

  // 응답보다 먼저 발행된 같은 런의 false 이벤트는 로컬 잠금을 풀지 않는다.
  const delayedOldSession = { ...base, updated_at: "2026-08-25T06:00:00.150Z" };
  assert.equal(resetPendingMarkerResolved(marker, delayedOldSession), false);
  assert.equal(applyResetPendingMarker(delayedOldSession, marker).reset_pending, true);
});

test("authoritative pending or OFF session resolves the local latch", () => {
  const response = { ...base, reset_pending: true, updated_at: "2026-08-25T06:00:00.200Z" };
  const marker = createResetPendingMarker(base, response);

  assert.equal(resetPendingMarkerResolved(marker, response), true);
  assert.equal(resetPendingMarkerResolved(marker, {
    ...response,
    run_id: null,
    reset_pending: false,
    updated_at: "2026-08-25T06:00:00.300Z",
  }), true);
});

test("a stale reset response cannot latch over a finalized or newer session", () => {
  const response = { ...base, reset_pending: true, updated_at: "2026-08-25T06:00:00.200Z" };
  const finalized = { ...base, run_id: null, updated_at: "2026-08-25T06:00:00.300Z" };
  const newer = { ...base, updated_at: "2026-08-25T06:00:00.300Z" };

  assert.equal(createResetPendingMarker(finalized, response), null);
  assert.equal(createResetPendingMarker(newer, response), null);
});
