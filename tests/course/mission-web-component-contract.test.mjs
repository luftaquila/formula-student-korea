import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mapSource = readFileSync(new URL("../../course/web/src/views/MapView.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../course/web/src/App.vue", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = mapSource.indexOf(`function ${name}(`);
  const end = nextName ? mapSource.indexOf(`function ${nextName}(`, start + 1) : -1;
  assert.ok(start >= 0, `missing ${name}`);
  return mapSource.slice(start, end >= 0 ? end : undefined);
}

test("keeps an accepted end visible until terminal mission authority arrives", () => {
  const abandon = functionSource("abandonMission", "onPathBtn");
  assert.match(abandon, /await response\.json\(\)/);
  assert.match(abandon, /applyMissionCommandResponse\(data, "end", authorityToken\)/);
  assert.match(abandon, /missionEndAwaitingAckId/);
  assert.doesNotMatch(abandon, /clearPath\(/);
  assert.match(mapSource, /mission\.status === "cancelled"[\s\S]*applyAuthoritativeMissionAbsence\(\)/);
  assert.match(mapSource, /catch \(err\) \{\s*await reconcileMissionEndRequestFailure\(missionId\)/);
  const reconcile = functionSource("reconcileMissionEndRequestFailure", "startExistingPath");
  assert.match(reconcile, /reconcileMissionEndAuthorityRequest\([\s\S]*getCurrentState[\s\S]*fetchActiveMission/);
  assert.match(reconcile, /result\.outcome === "retry"[\s\S]*scheduleMissionEndReconcile\(missionId\)/);
  const schedule = functionSource("scheduleMissionEndReconcile", "reconcileMissionEndRequestFailure");
  assert.match(schedule, /missionEndReconcileShouldRetry[\s\S]*setTimeout\([\s\S]*reconcileMissionEndRequestFailure\(missionId, expectedEpoch\)/);
  const cancel = functionSource("cancelMissionEndReconcile", "scheduleMissionEndReconcile");
  assert.match(cancel, /missionEndReconcileEpoch \+= 1/);
});

test("fences status, mutation, and pending-create responses with independent authority tokens", () => {
  const status = functionSource("fetchRoverStatus", "restoreActiveMission");
  assert.match(status, /splitMissionStatusPayload/);
  assert.match(status, /missionAuthorityRequestCanApply/);
  const execute = functionSource("executePath", "resumePath");
  assert.match(execute, /captureMissionCreateRouteAuthority/);
  assert.match(execute, /missionCreateRouteAuthorityMatches/);
  assert.ok(execute.indexOf("missionCreateRouteAuthorityMatches")
    < execute.indexOf("/start`"), "route authority must be checked before start");
  assert.match(mapSource, /watch\(activeCourseId,[\s\S]*flush: "sync"/);
  assert.match(mapSource, /const activeMissionAuthority = ref\(null\)/);
  assert.match(mapSource, /activeMissionAuthority\.value = mission/);
  assert.match(execute, /missionCreateSettlementDecision[\s\S]*clearPath\(\{ endMissionOnServer: false \}\)/);
});

test("invalidates an open mission preflight before and after route synchronization", () => {
  const confirm = functionSource("confirmPreflight", "syncMissionRemaining");
  assert.ok(confirm.indexOf("missionAuthorityFenceIsCurrent") < confirm.indexOf("resumePath("));
  const start = functionSource("startExistingPath", "executePath");
  const resume = functionSource("resumePath", "updatePathProgress");
  assert.match(start, /commandAuthorityFence[\s\S]*beginMissionAuthorityRequest[\s\S]*missionAuthorityFenceIsCurrent/);
  assert.match(resume, /commandAuthorityFence[\s\S]*beginMissionAuthorityRequest[\s\S]*missionAuthorityFenceIsCurrent/);
});

test("uses summary authority for immediate course alignment and terminal path cleanup", () => {
  const summary = functionSource("applyActiveMissionSummary", "fetchRoverStatus");
  assert.ok(summary.indexOf("observeMissionAuthority(summary)") < summary.indexOf("alignCourseToMission(summary)"));
  const absent = functionSource("applyAuthoritativeMissionAbsence", "installActiveMissionSnapshot");
  assert.match(absent, /authorityMissionId = activeMissionAuthority\.value\?\.id/);
  assert.match(absent, /missionAbsentSnapshotDecision\(\{[\s\S]*authorityMissionId/);
  assert.match(absent, /decision\.terminalMissionId/);
});

test("deduplicates unchanged summaries and already-rendered mission revisions", () => {
  const summary = functionSource("applyActiveMissionSummary", "fetchRoverStatus");
  assert.ok(summary.indexOf("if (refresh.unchanged)") < summary.indexOf("mergeMissionSummary"));
  const restore = functionSource("restoreActiveMission", "reconcileRoverMode");
  assert.match(restore, /displayedMissionAuthorityKey === authorityKey\) return/);
});

test("releases the clear button on a server-confirmed paused V2 mission", () => {
  assert.match(appSource, /cur === "PAUSED" && stopRequested === false/);
  assert.match(appSource, /provide\("roverStopRequested", roverStopRequested\)/);
  assert.match(mapSource, /appRoverStopRequested\.value = data\.stop_requested/);
});
