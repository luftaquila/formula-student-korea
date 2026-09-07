import assert from "node:assert/strict";
import test from "node:test";

import { findInspectionCategory } from "../../queue/web/src/inspection-category.js";

test("finds the one applicable inspection category with an optional name suffix", () => {
  const categories = [
    { id: 1, name: "전기 검차", excluded_types: ["CV"] },
    { id: 2, name: "제동", excluded_types: [] },
  ];

  assert.equal(findInspectionCategory(categories, "전기", "EV")?.id, 1);
  assert.equal(findInspectionCategory(categories, "제동", "CV")?.id, 2);
});

test("fails closed for an excluded, missing, or ambiguous category", () => {
  const categories = [
    { id: 1, name: "전기", excluded_types: ["CV"] },
    { id: 2, name: "전기 검차", excluded_types: [] },
  ];

  assert.equal(findInspectionCategory(categories, "전기", "CV")?.id, 2);
  assert.equal(findInspectionCategory(categories, "전기", "EV"), null);
  assert.equal(findInspectionCategory(categories, "보고서", "EV"), null);
});
