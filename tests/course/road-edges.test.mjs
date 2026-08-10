import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { buildRoadEdges } from "../../course/lib/road-edges.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

describe("buildRoadEdges — flat course (no alt)", () => {
  const cones = loadFixture("endurance").cones;
  const cl = computeCenterline(cones, { step: 1.0, metric: true });
  const e = buildRoadEdges(cl);

  it("produces one edge point per centerline station", () => {
    const n = cl.metric.P.length;
    assert.equal(e.Le.length, n);
    assert.equal(e.Re.length, n);
    assert.equal(e.width.length, n);
  });

  it("has finite edges and positive road width everywhere", () => {
    for (let i = 0; i < e.Le.length; i++) {
      assert.ok(Number.isFinite(e.Le[i][0]) && Number.isFinite(e.Le[i][1]));
      assert.ok(Number.isFinite(e.Re[i][0]) && Number.isFinite(e.Re[i][1]));
      assert.ok(e.width[i] > 0, `width ${e.width[i]} at ${i}`);
    }
  });

  it("is flat: no elevation, all z and bank zero", () => {
    assert.equal(e.hasElevation, false);
    assert.equal(e.relief, 0);
    assert.ok(e.zC.every((v) => v === 0));
    assert.ok(e.zL.every((v) => v === 0));
    assert.ok(e.zR.every((v) => v === 0));
    assert.ok(e.bank.every((v) => v === 0));
  });

  it("has a plausible median road width (2–20 m)", () => {
    const w = e.width.slice().sort((a, b) => a - b);
    const median = w[Math.floor(w.length / 2)];
    assert.ok(median > 2 && median < 20, `median width ${median.toFixed(2)} m`);
  });
});

describe("buildRoadEdges — banked course (alt tilt)", () => {
  // Tilt the whole course along longitude so the two track edges sit at
  // different altitudes on stretches that run across the tilt -> banking.
  const base = loadFixture("endurance").cones;
  const meanLng = base.reduce((s, c) => s + c.lng, 0) / base.length;
  const cones = base.map((c) => ({ ...c, alt: 2000 * (c.lng - meanLng) }));
  const cl = computeCenterline(cones, { step: 1.0, metric: true });
  const e = buildRoadEdges(cl);

  it("detects elevation with positive relief", () => {
    assert.equal(e.hasElevation, true);
    assert.ok(e.relief > 0, `relief ${e.relief}`);
  });

  it("banks where the two edges differ in altitude", () => {
    let sawBank = false;
    for (let i = 0; i < e.bank.length; i++) {
      const dz = e.zL[i] - e.zR[i];
      if (Math.abs(dz) > 0.05) {
        assert.ok(Math.abs(e.bank[i]) > 1e-3, `zL!=zR but bank ~0 at ${i}`);
        sawBank = true;
      } else {
        assert.ok(Math.abs(e.bank[i]) < 0.05, `zL~=zR but large bank at ${i}`);
      }
    }
    assert.ok(sawBank, "tilted course produced no banking anywhere");
  });

  it("keeps the lowest centerline point at z = 0", () => {
    assert.ok(Math.min(...e.zC) >= -1e-9);
    assert.ok(Math.abs(Math.min(...e.zC)) < 1e-9);
  });
});

describe("buildRoadEdges — center cone altitude isolation", () => {
  const base = loadFixture("endurance").cones;
  const meanLat = base.reduce((s, c) => s + c.lat, 0) / base.length;
  const meanLng = base.reduce((s, c) => s + c.lng, 0) / base.length;
  const withCenterAlt = (centerAlt) => base.map((c) => ({
    ...c,
    alt: c.side === "center"
      ? centerAlt
      : 40 + 4000 * (c.lat - meanLat) + 1000 * (c.lng - meanLng),
  }));

  it("does not let a lying center cone change relief, grade or bank", () => {
    const low = buildRoadEdges(computeCenterline(withCenterAlt(-1000), { step: 1.0, metric: true }));
    const high = buildRoadEdges(computeCenterline(withCenterAlt(1000), { step: 1.0, metric: true }));
    for (const key of ["zC", "zL", "zR", "bank"]) assert.deepEqual(high[key], low[key], key);
    assert.equal(high.relief, low.relief);
  });

  it("does not treat center-only altitude as course elevation", () => {
    const cones = base.map((c, i) => c.side === "center" ? { ...c, alt: 500 + i } : { ...c, alt: null });
    const e = buildRoadEdges(computeCenterline(cones, { step: 1.0, metric: true }));
    assert.equal(e.hasElevation, false);
    assert.ok(e.zC.every((z) => z === 0));
  });
});

describe("buildRoadEdges — partial boundary survey", () => {
  it("keeps longitudinal relief when only one geometric side has altitude", () => {
    const N = 24;
    const P = [], inner = [], outer = [];
    for (let i = 0; i < N; i++) {
      const a = 2 * Math.PI * i / N;
      const cx = 10 * Math.cos(a), cy = 10 * Math.sin(a);
      P.push([cx, cy]);
      inner.push([8 * Math.cos(a), 8 * Math.sin(a), 50 + 0.1 * cy]);
      outer.push([12 * Math.cos(a), 12 * Math.sin(a), null]);
    }
    const e = buildRoadEdges({ metric: { P, left: inner, right: outer, centers: [], width: 4 } }, { elevSigma: 2 });
    assert.equal(e.hasElevation, true);
    assert.ok(e.relief > 1, `relief ${e.relief}`);
    assert.deepEqual(e.zL, e.zR);
    assert.ok(e.bank.every((v) => v === 0));
  });
});

describe("buildRoadEdges — extra width (except slalom)", () => {
  const cones = loadFixture("endurance").cones;
  const cl = computeCenterline(cones, { step: 1.0, metric: true });
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  it("widens each side by extraWidthPerSide but leaves the slalom untouched", () => {
    const base = buildRoadEdges(cl, { extraWidthPerSide: 0 });
    const wide = buildRoadEdges(cl, { extraWidthPerSide: 1 });
    // ~+2 m to the median road width (1 m per side)
    assert.ok(Math.abs((median(wide.width) - median(base.width)) - 2) < 0.4,
      `median delta ${(median(wide.width) - median(base.width)).toFixed(2)} m`);
    // the slalom (widest, center-boosted) stretch is excluded -> max unchanged
    assert.ok(Math.abs(Math.max(...wide.width) - Math.max(...base.width)) < 0.25,
      "slalom width should not change");
  });
});
