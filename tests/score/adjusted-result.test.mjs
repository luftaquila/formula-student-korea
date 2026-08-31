import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateAdjustedResult } from "../../score/lib/adjusted-result.mjs";

describe("event scoring result", () => {
  it("averages the skidpad lap sum before adding all cone penalties", () => {
    assert.equal(calculateAdjustedResult("스키드패드", {
      result: 30_000,
      status: null,
      cones: 4,
      oc: 0,
    }, {
      cone_penalty: 0.3,
      oc_penalty: 0,
    }), 16_200);
  });

  it("keeps non-skidpad measured times unchanged before penalties", () => {
    assert.equal(calculateAdjustedResult("오토크로스", {
      result: 50_000,
      status: null,
      cones: 1,
      oc: 1,
    }, {
      cone_penalty: 2,
      oc_penalty: 20,
    }), 72_000);
  });

  it("does not produce a scoring time for classified runs", () => {
    assert.equal(calculateAdjustedResult("스키드패드", {
      result: 30_000,
      status: "DNF",
      cones: 0,
      oc: 0,
    }, {
      cone_penalty: 0.3,
    }), null);
  });
});
