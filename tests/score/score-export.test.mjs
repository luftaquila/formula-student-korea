import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEventExportCells,
  buildEventExportHeaders,
  formatScoreResult,
} from "../../score/web/src/lib/scoreExport.js";

describe("score sheet event export", () => {
  it("adds score, Best, and four valid-run columns for a dynamic event", () => {
    assert.deepEqual(buildEventExportHeaders("가속"), [
      "가속 점수",
      "가속 Best 기록",
      "가속 유효 기록 1",
      "가속 유효 기록 2",
      "가속 유효 기록 3",
      "가속 유효 기록 4",
    ]);
    assert.deepEqual(buildEventExportHeaders("내구", { runLimit: 0 }), [
      "내구 점수",
      "내구 Best 기록",
    ]);
  });

  it("exports the first four finished, non-invalidated runs with penalties applied", () => {
    const record = {
      result: 49_000,
      cones: 1,
      oc: 0,
      allRuns: [
        { result: 49_000, cones: 1, oc: 0, invalidated: 0 },
        { result: 47_000, cones: 0, oc: 0, invalidated: 1 },
        { result: -1, cones: 0, oc: 0, invalidated: 0 },
        { result: 50_000, cones: 0, oc: 1, invalidated: 0 },
        { result: 52_000, cones: 0, oc: 0, invalidated: 0 },
        { result: 53_000, cones: 2, oc: 0, invalidated: 0 },
        { result: 54_000, cones: 0, oc: 0, invalidated: 0 },
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
      "01:00.000",
      "00:52.000",
      "00:57.000",
    ]);
  });

  it("pads missing valid runs while preserving zero scores and DNF Best results", () => {
    assert.deepEqual(buildEventExportCells({
      record: {
        result: -1,
        allRuns: [
          { result: 61_234, cones: 0, oc: 0, invalidated: 0 },
          { result: null, cones: 0, oc: 0, invalidated: 0 },
        ],
      },
      score: 0,
      penalty: {},
    }), [0, "DNF", "01:01.234", "", "", ""]);
  });

  it("formats rounded millisecond results consistently with the score board", () => {
    assert.equal(formatScoreResult(62_999.6), "01:03.000");
    assert.equal(formatScoreResult(null), "-");
  });
});
