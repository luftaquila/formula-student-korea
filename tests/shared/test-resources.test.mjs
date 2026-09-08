import test from "node:test";
import assert from "node:assert/strict";
import { assertTestResourceLimits } from "../../scripts/lib/test-resources.mjs";

const limits = { memory: String(1024 ** 3), swap: "0", tasks: "256" };
test("test isolation accepts the budget and stricter limits", () => {
  assert.doesNotThrow(() => assertTestResourceLimits(limits));
  assert.doesNotThrow(() => assertTestResourceLimits({ memory: "134217728", swap: "0", tasks: "64" }));
});
for (const [key, values] of Object.entries({
  memory: ["max", String(1024 ** 3 + 1), "", "invalid", "0"],
  swap: ["max", "1", ""],
  tasks: ["max", "257", "0", ""],
})) {
  for (const value of values) {
    test(`test isolation refuses unsafe ${key}=${JSON.stringify(value)}`, () => {
      assert.throws(() => assertTestResourceLimits({ ...limits, [key]: value }), /cgroup/);
    });
  }
}
