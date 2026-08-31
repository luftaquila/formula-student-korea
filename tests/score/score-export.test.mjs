import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatScoreResult } from "../../score/web/src/lib/scoreExport.js";

describe("score result display", () => {
  it("formats rounded millisecond results consistently with the score board", () => {
    assert.equal(formatScoreResult(62_999.6), "01:03.000");
    assert.equal(formatScoreResult(null), "-");
  });
});
