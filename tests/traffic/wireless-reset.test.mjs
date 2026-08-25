import test from "node:test";
import assert from "node:assert/strict";
import {
  applyResetPendingMarker,
  applyVirtualResetMarker,
  createResetPendingMarker,
  createVirtualResetMarker,
  resetPendingMarkerResolved,
  virtualResetMarkerResolved,
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

test("virtual reset response completes the cached run when its session SSE was omitted", () => {
  const response = {
    ...base,
    armed: false,
    light_color: "off",
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    reset_pending: false,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const marker = createVirtualResetMarker(base, response, "run-1");
  const effective = applyVirtualResetMarker(base, marker);

  assert.deepEqual(marker, { run_id: "run-1", updated_at: response.updated_at });
  assert.equal(effective.armed, false);
  assert.equal(effective.light_color, "off");
  assert.equal(effective.run_id, null);
  assert.equal(effective.saved_record_name, null);
  assert.equal(effective.saved_record_rowid, null);

  // reset 응답보다 오래된 이전 런 SSE가 늦게 와도 완료 상태를 되살리지 않는다.
  const delayedOldSession = { ...base, updated_at: "2026-08-25T06:00:00.150Z" };
  assert.equal(virtualResetMarkerResolved(marker, delayedOldSession), false);
  assert.equal(applyVirtualResetMarker(delayedOldSession, marker).run_id, null);
});

test("authoritative reset completion or a new run resolves the virtual reset latch", () => {
  const response = {
    ...base,
    armed: false,
    light_color: "off",
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    reset_pending: false,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const marker = createVirtualResetMarker(base, response, "run-1");

  assert.equal(virtualResetMarkerResolved(marker, response), true);
  assert.equal(virtualResetMarkerResolved(marker, {
    ...base,
    run_id: "run-2",
    updated_at: "2026-08-25T06:00:00.300Z",
  }), true);
});

test("stale virtual reset response cannot clear a newer run", () => {
  const response = {
    ...base,
    armed: false,
    light_color: "off",
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    reset_pending: false,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const newRun = { ...base, run_id: "run-2", updated_at: "2026-08-25T06:00:00.300Z" };

  assert.equal(createVirtualResetMarker(newRun, response, "run-1"), null);
});
