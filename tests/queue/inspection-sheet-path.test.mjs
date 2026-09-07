import assert from "node:assert/strict";
import test from "node:test";

import { inspectionSheetPath } from "../../queue/web/src/inspection-sheet-path.js";

test("inspection sheet path includes a category only when one is known", () => {
  assert.equal(
    inspectionSheetPath({ base: "/inspection", year: 2026, num: 12, categoryId: 91 }),
    "/inspection/2026/12?category=91",
  );
  assert.equal(
    inspectionSheetPath({ base: "/inspection", year: 2026, num: 12 }),
    "/inspection/2026/12",
  );
});

test("inspection sheet path escapes category identifiers", () => {
  assert.equal(
    inspectionSheetPath({ year: 2026, num: 12, categoryId: "visual & safety" }),
    "/2026/12?category=visual%20%26%20safety",
  );
});
