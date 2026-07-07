import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeStick, DEADZONE, EXPO } from "../../course/lib/stick.mjs";

describe("shapeStick — VR thumbstick response shaping", () => {
  it("returns 0 inside the dead zone (rest drift + hardware dead zone)", () => {
    assert.equal(shapeStick(0), 0);
    assert.equal(shapeStick(0.05), 0);
    assert.equal(shapeStick(DEADZONE - 0.001), 0);
    assert.equal(shapeStick(DEADZONE), 0);
    assert.equal(shapeStick(-DEADZONE), 0);
  });

  it("leaves 0 continuously at the dead-zone edge — no jump to ~0.2", () => {
    // The old linear map jumped to the raw value (~0.2 → 20/100) the instant the
    // controller started reporting. The rescale must ramp up from ~0 instead.
    const justPast = shapeStick(DEADZONE + 0.005);
    assert.ok(justPast > 0, "should be positive just past the dead zone");
    assert.ok(justPast < 0.02, `expected a small value near 0, got ${justPast}`);
    // 100× would give a sub-1 command — no visible snap to 20.
    assert.ok(Math.round(justPast * 100) <= 1);
  });

  it("preserves full range at full deflection", () => {
    assert.equal(shapeStick(1), 1);
    assert.equal(shapeStick(-1), -1);
  });

  it("clamps inputs beyond ±1", () => {
    assert.equal(shapeStick(1.5), 1);
    assert.equal(shapeStick(-2), -1);
  });

  it("is sign-symmetric", () => {
    for (const v of [0.3, 0.5, 0.75, 0.9]) {
      assert.equal(shapeStick(-v), -shapeStick(v));
    }
  });

  it("is monotonic increasing across the active range", () => {
    let prev = -Infinity;
    for (let v = DEADZONE; v <= 1.0001; v += 0.02) {
      const out = shapeStick(Math.min(1, v));
      assert.ok(out >= prev, `not monotonic at v=${v}: ${out} < ${prev}`);
      prev = out;
    }
  });

  it("expo softens the mid-stick response vs a linear rescale", () => {
    // At half deflection the expo output must sit below the linear-rescale output
    // (that softness is what makes fine control possible), yet stay positive.
    const half = 0.5;
    const linearRescale = (half - DEADZONE) / (1 - DEADZONE);
    const shaped = shapeStick(half);
    assert.ok(shaped > 0);
    assert.ok(shaped < linearRescale, `expo should soften: ${shaped} !< ${linearRescale}`);
  });

  it("expo=0 reduces to a pure linear rescale", () => {
    const v = 0.6;
    const linearRescale = (v - DEADZONE) / (1 - DEADZONE);
    assert.ok(Math.abs(shapeStick(v, { expo: 0 }) - linearRescale) < 1e-12);
  });

  it("honours a custom dead zone", () => {
    assert.equal(shapeStick(0.1, { deadzone: 0.15 }), 0);
    assert.ok(shapeStick(0.2, { deadzone: 0.15 }) > 0);
  });

  it("guards against non-finite input", () => {
    assert.equal(shapeStick(NaN), 0);
    assert.equal(shapeStick(Infinity), 0);
    assert.equal(shapeStick(undefined), 0);
  });

  it("exposes sane defaults", () => {
    assert.ok(DEADZONE > 0 && DEADZONE < 1);
    assert.ok(EXPO >= 0 && EXPO <= 1);
  });
});
