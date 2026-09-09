import test from "node:test";
import assert from "node:assert/strict";
import {
  applyResetMarker,
  createResetMarker,
  resetMarkerResolved,
} from "../../traffic/lib/wireless-reset.mjs";

const base = {
  event_type: "가속",
  run_id: "run-1",
  updated_at: "2026-08-25T06:00:00.100Z",
  controller: "admin@test.com#tab",
};

test("reset response completes the cached run when its session SSE was omitted", () => {
  const response = {
    ...base,
    armed: false,
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const marker = createResetMarker(base, response, "run-1");
  const effective = applyResetMarker(base, marker);

  assert.deepEqual(marker, { run_id: "run-1", updated_at: response.updated_at });
  assert.equal(effective.armed, false);
  assert.equal(effective.run_id, null);
  assert.equal(effective.saved_record_name, null);
  assert.equal(effective.saved_record_rowid, null);

  // reset 응답보다 오래된 이전 런 SSE가 늦게 와도 완료 상태를 되살리지 않는다.
  const delayedOldSession = { ...base, updated_at: "2026-08-25T06:00:00.150Z" };
  assert.equal(resetMarkerResolved(marker, delayedOldSession), false);
  assert.equal(applyResetMarker(delayedOldSession, marker).run_id, null);
});

test("reset tombstone persists until a new run replaces the old identity", () => {
  const response = {
    ...base,
    armed: false,
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const marker = createResetMarker(base, response, "run-1");

  assert.equal(resetMarkerResolved(marker, response), false);
  assert.equal(resetMarkerResolved(marker, {
    ...base,
    run_id: "run-2",
    updated_at: "2026-08-25T06:00:00.300Z",
  }), true);
});

test("stale reset response cannot clear a newer run", () => {
  const response = {
    ...base,
    armed: false,
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    updated_at: "2026-08-25T06:00:00.200Z",
  };
  const newRun = { ...base, run_id: "run-2", updated_at: "2026-08-25T06:00:00.300Z" };

  assert.equal(createResetMarker(newRun, response, "run-1"), null);
});
