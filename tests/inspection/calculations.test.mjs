import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCalculationEvaluator,
  formatCalculationValue,
  normalizeCalculationConfig,
  validateCalculationGraph,
} from "../../inspection/lib/calculations.mjs";

function item(id, fieldKey, calculation = null, answerType = "number") {
  return { id, field_key: fieldKey, calculation, answer_type: answerType };
}

describe("inspection calculations", () => {
  it("multiplies a source value and formats with configured precision", () => {
    const source = item(1, "current-voltage");
    const target = item(2, "imd", {
      mode: "computed", operation: "multiply", sources: ["current-voltage"], factor: 250, precision: 2,
    });
    const result = createCalculationEvaluator([source, target], { 1: { value: "421.5" } }).evaluate(target);
    assert.deepEqual(result, { status: "ok", value: 105375, precision: 2 });
    assert.equal(formatCalculationValue(result), "105,375");
  });

  it("uses inclusive range upper bounds at 200, 400, and 600 V", () => {
    const source = item(1, "max-voltage");
    const target = item(2, "tsmp", {
      mode: "suggestion", operation: "range_lookup", sources: ["max-voltage"], precision: 0,
      ranges: [{ max: 200, value: 5 }, { max: 400, value: 10 }, { max: 600, value: 15 }],
    });
    const expected = [[200, 5], [200.01, 10], [400, 10], [400.01, 15], [600, 15]];
    for (const [voltage, resistance] of expected) {
      const result = createCalculationEvaluator([source, target], { 1: String(voltage) }).evaluate(target);
      assert.equal(result.status, "ok");
      assert.equal(result.value, resistance);
    }
    assert.equal(createCalculationEvaluator([source, target], { 1: "600.01" }).evaluate(target).status, "out_of_range");
  });

  it("reports a missing source answer instead of producing zero", () => {
    const source = item(1, "source");
    const target = item(2, "target", {
      mode: "computed", operation: "multiply", sources: ["source"], factor: 250, precision: 0,
    });
    assert.equal(createCalculationEvaluator([source, target], {}).evaluate(target).status, "missing");
  });

  it("supports computed fields as sources for later calculations", () => {
    const a = item(1, "a");
    const doubled = item(2, "doubled", {
      mode: "computed", operation: "multiply", sources: ["a"], factor: 2, precision: 0,
    });
    const total = item(3, "total", {
      mode: "computed", operation: "sum", sources: ["a", "doubled"], precision: 0,
    });
    assert.equal(createCalculationEvaluator([a, doubled, total], { 1: "4" }).evaluate(total).value, 12);
  });

  it("rejects duplicate ranges and cyclic references", () => {
    assert.throws(() => normalizeCalculationConfig({
      mode: "suggestion", operation: "range_lookup", sources: ["source"],
      ranges: [{ max: 200, value: 5 }, { max: 200, value: 10 }],
    }), /같은 구간 상한/);

    const a = item(1, "a", { mode: "computed", operation: "sum", sources: ["b"], precision: 0 });
    const b = item(2, "b", { mode: "computed", operation: "sum", sources: ["a"], precision: 0 });
    assert.throws(() => validateCalculationGraph([a, b]), /순환 참조/);
  });

  it("rejects non-numeric source types", () => {
    const source = item(1, "source", null, "text");
    const target = item(2, "target", {
      mode: "computed", operation: "sum", sources: ["source"], precision: 0,
    });
    assert.throws(() => validateCalculationGraph([source, target]), /숫자 또는 증감 숫자/);
  });
});
