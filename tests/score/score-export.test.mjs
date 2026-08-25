import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEventExportCells,
  buildEventExportHeaders,
  formatScoreResult,
} from "../../score/web/src/lib/scoreExport.js";

describe("score sheet event export", () => {
  it("adds score, best-record, and four run columns for a dynamic event", () => {
    assert.deepEqual(buildEventExportHeaders("가속"), [
      "가속 점수",
      "가속 최고 기록",
      "가속 기록 1",
      "가속 기록 2",
      "가속 기록 3",
      "가속 기록 4",
    ]);
    assert.deepEqual(buildEventExportHeaders("내구", { runLimit: 0, recordLabel: "기록" }), [
      "내구 점수",
      "내구 기록",
    ]);
  });

  it("exports the first four attempts with explicit statuses and normal-run penalties", () => {
    const record = {
      result: 49_000,
      cones: 1,
      oc: 0,
      allRuns: [
        { result: 49_000, status: null, cones: 1, oc: 0 },
        { result: 47_000, status: "DSQ", cones: 0, oc: 0 },
        { result: null, status: "DNF", cones: 0, oc: 0 },
        { result: 50_000, status: null, cones: 0, oc: 1 },
        { result: 52_000, status: null, cones: 0, oc: 0 },
      ],
    };

    assert.deepEqual(buildEventExportCells({
      record,
      score: 72.5,
      penalty: { cone_penalty: 2, oc_penalty: 10 },
    }), [
      72.5,
      "00:51.000",
      "00:51.000",
      "DSQ",
      "DNF",
      "01:00.000",
    ]);
  });

  it("pads missing attempts while preserving zero scores and explicit DNF", () => {
    assert.deepEqual(buildEventExportCells({
      record: {
        result: null,
        status: "DNF",
        allRuns: [
          { result: 61_234, status: null, cones: 0, oc: 0 },
          { result: null, status: "DNS", cones: 0, oc: 0 },
        ],
      },
      score: 0,
      penalty: {},
    }), [0, "DNF", "01:01.234", "DNS", "", ""]);
  });

  it("formats rounded millisecond results consistently with the score board", () => {
    assert.equal(formatScoreResult(62_999.6), "01:03.000");
    assert.equal(formatScoreResult(null), "-");
  });
});
