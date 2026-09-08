import assert from "node:assert/strict";
import test from "node:test";

import {
  scoreboardElapsedSeconds,
  scoreboardLiveAttempt,
  scoreboardRecordEffects,
  scoreboardRecordFiles,
  scoreboardSerialLiveAttempt,
} from "../../traffic/web/src/utils/scoreboard-live.js";

const YEAR = 2026;
const FILE = "FSK 2026 다이나믹";
const SESSION = {
  event_type: "가속",
  armed: true,
  run_id: "run-1",
  event_name: "다이나믹",
  team: { num: 7, univ: "한국대학교", team: "Korea Racing" },
  saved_record_name: null,
  saved_record_rowid: null,
};
const TIMING = {
  start: { timestamp: new Date("2026-09-08T01:00:00.000Z") },
  clockDisplay: "00:01.234",
};

test("scoreboard offers an armed wireless event before its first record exists", () => {
  assert.deepEqual(scoreboardRecordFiles({
    persistedFiles: ["controller", "FSK 2026 기존 경기"],
    sessions: {
      가속: SESSION,
      내구: { ...SESSION, event_type: "내구", event_name: "내구 경기" },
    },
    year: YEAR,
    eventTypes: ["가속", "스키드패드", "오토크로스"],
  }), ["FSK 2026 기존 경기", FILE]);
});

test("scoreboard offers an active serial event before its first record exists", () => {
  assert.deepEqual(scoreboardRecordFiles({
    persistedFiles: ["controller"],
    liveAttempts: {
      가속: { active: true, event_type: "가속", event_name: "다이나믹" },
      내구: { active: true, event_type: "내구", event_name: "내구 경기" },
    },
    year: YEAR,
    eventTypes: ["가속", "스키드패드", "오토크로스"],
  }), [FILE]);
});

test("scoreboard exposes the running clock and the active team after the start sensor", () => {
  assert.deepEqual(scoreboardLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    session: SESSION,
    timing: TIMING,
    records: [],
  }), {
    num: 7,
    univ: "한국대학교",
    team: "Korea Racing",
    elapsedSeconds: "1.234",
    measuring: true,
  });

  assert.equal(scoreboardLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    session: SESSION,
    timing: { ...TIMING, start: { timestamp: null } },
    records: [],
  }), null);
});

test("scoreboard formats the running clock as seconds without a minute prefix", () => {
  assert.equal(scoreboardElapsedSeconds("00:00.000"), "0.000");
  assert.equal(scoreboardElapsedSeconds("00:09.876"), "9.876");
  assert.equal(scoreboardElapsedSeconds("01:02.003"), "62.003");
});

test("scoreboard keeps the running clock until the finalized record is loaded", () => {
  const finalizedSession = {
    ...SESSION,
    saved_record_name: FILE,
    saved_record_rowid: 12,
  };

  assert.ok(scoreboardLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    session: finalizedSession,
    timing: TIMING,
    records: [],
  }));
  assert.equal(scoreboardLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    session: finalizedSession,
    timing: TIMING,
    records: [{ rowid: 12, result: 4567 }],
  }), null);
});

test("scoreboard ignores inactive or unrelated wireless attempts", () => {
  assert.equal(scoreboardLiveAttempt({
    selectedFile: "FSK 2026 다른 경기",
    year: YEAR,
    session: SESSION,
    timing: TIMING,
    records: [],
  }), null);
  assert.equal(scoreboardLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    session: { ...SESSION, armed: false },
    timing: TIMING,
    records: [],
  }), null);
});

test("scoreboard exposes a serial attempt with a locally advancing clock", () => {
  const attempt = {
    active: true,
    attempt_id: "attempt-1",
    event_type: "스키드패드",
    event_name: "다이나믹",
    team: { num: 7, univ: "한국대학교", team: "Korea Racing" },
    elapsed_ms: 250,
    received_at: 1_000,
  };

  assert.deepEqual(scoreboardSerialLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    attempt,
    now: 2_000,
  }), {
    num: 7,
    univ: "한국대학교",
    team: "Korea Racing",
    elapsedSeconds: "1.250",
    measuring: true,
  });
  assert.equal(scoreboardSerialLiveAttempt({
    selectedFile: FILE,
    year: YEAR,
    attempt: { ...attempt, active: false },
    now: 2_000,
  }), null);
});

test("scoreboard identifies record confirmations and genuine best improvements", () => {
  const baseline = {
    rowid: 1,
    time: "2026-09-08T01:00:00.000Z",
    type: "가속",
    scoreboard: 1,
    result: 5_000,
    status: null,
  };
  const fasterRecord = {
    rowid: 2,
    time: "2026-09-08T01:01:00.000Z",
    type: "가속",
    scoreboard: 1,
    result: 4_500,
    status: null,
  };
  assert.deepEqual(
    scoreboardRecordEffects(
      { latest: { 가속: baseline }, best: { 가속: baseline } },
      { latest: { 가속: fasterRecord }, best: { 가속: fasterRecord } },
      ["가속"],
    ),
    { confirmed: ["가속"], bestUpdated: ["가속"] },
  );

  const slowerRecord = {
    ...fasterRecord,
    rowid: 3,
    time: "2026-09-08T01:02:00.000Z",
    result: 5_500,
  };
  assert.deepEqual(
    scoreboardRecordEffects(
      { latest: { 가속: fasterRecord }, best: { 가속: fasterRecord } },
      { latest: { 가속: slowerRecord }, best: { 가속: fasterRecord } },
      ["가속"],
    ),
    { confirmed: ["가속"], bestUpdated: [] },
  );
});
