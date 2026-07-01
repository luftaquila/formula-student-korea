import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fitParametric, reinschFit } from "../../shared/smoothing-spline.mjs";

describe("reinschFit", () => {
  it("interpolates exactly at the knots when s = 0", () => {
    const pts = [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]];
    const u = pts.map((_, i) => i / (pts.length - 1));
    const { gs } = reinschFit(u, [pts.map((p) => p[0]), pts.map((p) => p[1])], pts.map(() => 1), 0);
    for (let i = 0; i < pts.length; i++) {
      assert.ok(Math.abs(gs[0][i] - pts[i][0]) < 1e-9);
      assert.ok(Math.abs(gs[1][i] - pts[i][1]) < 1e-9);
    }
  });
});

describe("fitParametric", () => {
  it("leaves a straight line straight", () => {
    const line = Array.from({ length: 10 }, (_, i) => [i, 2 * i + 1]);
    const out = fitParametric(line, line.map(() => 1), line.length * 1.5, 20);
    let maxDev = 0;
    for (const [x, y] of out) maxDev = Math.max(maxDev, Math.abs(y - (2 * x + 1)));
    assert.ok(maxDev < 1e-6, `deviation ${maxDev}`);
  });

  it("smooths a zigzag (roughness drops by orders of magnitude)", () => {
    const zig = Array.from({ length: 21 }, (_, i) => [i, i % 2]);
    const out = fitParametric(zig, zig.map(() => 1), zig.length * 1.5, 41);
    const rough = (a) => {
      let r = 0;
      for (let i = 1; i < a.length - 1; i++) { const d = a[i + 1][1] - 2 * a[i][1] + a[i - 1][1]; r += d * d; }
      return r;
    };
    assert.ok(rough(out) < rough(zig) / 100, "zigzag was not smoothed");
  });

  it("passes essentially through a high-weight anchor while smoothing low-weight ones", () => {
    const anchors = [[0, 0], [1, 0], [2, 0], [3, 3], [4, 0], [5, 0], [6, 0]];
    const w = anchors.map((_, i) => (i === 3 ? 20 : 1));
    const out = fitParametric(anchors, w, anchors.length * 1.5, 61);
    let peak = 0;
    for (const [, y] of out) peak = Math.max(peak, y);
    assert.ok(peak > 2.9, `high-weight anchor (y=3) reached only ${peak.toFixed(2)}`);
  });

  it("returns the input unchanged for degenerate (all-coincident) points", () => {
    const same = [[1, 1], [1, 1], [1, 1], [1, 1]];
    const out = fitParametric(same, same.map(() => 1), 6, 10);
    assert.deepEqual(out, same);
  });
});
