import assert from "node:assert/strict";
import test from "node:test";

import { inspectorDisplay } from "../../inspection/web/src/utils/inspector-display.js";

test("inspector display shows up to two names without decoration", () => {
  assert.deepEqual(inspectorDisplay([]), {
    names: [],
    preview: "",
    remaining: 0,
    expandable: false,
  });
  assert.deepEqual(inspectorDisplay(["김검차"]), {
    names: ["김검차"],
    preview: "김검차",
    remaining: 0,
    expandable: false,
  });
  assert.deepEqual(inspectorDisplay(["김검차", "이검차"]), {
    names: ["김검차", "이검차"],
    preview: "김검차, 이검차",
    remaining: 0,
    expandable: false,
  });
});

test("inspector display summarizes additional names after the first two", () => {
  assert.deepEqual(inspectorDisplay(["김검차", "이검차", "박검차", "최검차"]), {
    names: ["김검차", "이검차", "박검차", "최검차"],
    preview: "김검차, 이검차",
    remaining: 2,
    expandable: true,
  });
});
