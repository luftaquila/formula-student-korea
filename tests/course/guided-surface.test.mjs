import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { computeGuidedRoute } from "../../course/lib/guided-route.mjs";
import { buildGuidedTrackModel } from "../../course/lib/guided-track-build.mjs";
import { measuredSkidpadFixture } from "./fixtures/measured-skidpad.mjs";

// The signed corridor field the road surface is contoured against: positive on
// asphalt. Mirrors closestEdgeSample, including its 1 m driveability shoulder.
function corridorField(metric, x, y) {
  let best = Infinity, halfWidth = 0;
  for (const edgeId of metric.usedEdgeIds) {
    const edge = metric.graph.edges[edgeId];
    const a = metric.graph.nodes[edge.a], b = metric.graph.nodes[edge.b];
    const ex = b.point[0] - a.point[0], ey = b.point[1] - a.point[1];
    const den = ex * ex + ey * ey;
    const t = den > 1e-12 ? Math.max(0, Math.min(1, ((x - a.point[0]) * ex + (y - a.point[1]) * ey) / den)) : 0;
    const d2 = (x - (a.point[0] + t * ex)) ** 2 + (y - (a.point[1] + t * ey)) ** 2;
    if (d2 < best) { best = d2; halfWidth = a.halfWidth + t * (b.halfWidth - a.halfWidth) + 1; }
  }
  return halfWidth - Math.sqrt(best);
}

function edgeUseCounts(indices) {
  const counts = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];

describe("guided road surface — the rim follows the corridor", () => {
  let route, track, counts;

  before(() => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    route = computeGuidedRoute(cones, markers, steps, { step: 1.0 });
    track = buildGuidedTrackModel(route, cones, { name: "surface" });
    counts = edgeUseCounts(track.mapGeometry.indices);
  });

  // Emitting whole grid cells could only ever follow the 0.5 m lattice, which
  // left a skidpad circle faceted and up to ~0.7 m off the surveyed edge. The
  // contour must land the rim on the corridor regardless of cell size.
  it("keeps the asphalt boundary on the surveyed edge, not on a cell wall", () => {
    const { positions } = track.mapGeometry;
    const errors = [];
    for (const [key, used] of counts) {
      if (used !== 1) continue;
      const [a, b] = key.split(":").map(Number);
      const mx = (positions[a][0] + positions[b][0]) / 2;
      const my = (-positions[a][2] + -positions[b][2]) / 2;
      errors.push(Math.abs(corridorField(route.metric, mx, my)));
    }
    assert.ok(errors.length > 200, `expected a tessellated rim, got ${errors.length} boundary edges`);
    errors.sort((x, y) => x - y);
    const p99 = quantile(errors, 0.99), max = quantile(errors, 1);
    assert.ok(p99 <= 0.1, `99% of the rim must sit within 0.1 m of the corridor edge (got ${p99.toFixed(3)} m)`);
    assert.ok(max <= 0.25, `no rim point may stray 0.25 m from the corridor edge (got ${max.toFixed(3)} m)`);
  });

  // Shared vertices are what make a repeatedly-driven waist one collision
  // surface instead of stacked coplanar road, so the contour must not tear it.
  it("stays watertight and manifold so junctions remain a single surface", () => {
    const overused = [...counts.values()].filter((used) => used > 2).length;
    assert.equal(overused, 0, "no edge may be shared by more than two triangles");

    const degree = new Map();
    for (const [key, used] of counts) {
      if (used !== 1) continue;
      for (const v of key.split(":").map(Number)) degree.set(v, (degree.get(v) || 0) + 1);
    }
    const dangling = [...degree.values()].filter((d) => d !== 2).length;
    assert.equal(dangling, 0, "every boundary vertex must close into a rim loop");
  });

  it("does not blow the vertex budget to buy that accuracy", () => {
    assert.ok(track.surface.vertices <= 62000, `vertices ${track.surface.vertices}`);
    assert.ok(track.surface.triangles > 0);
  });
});

describe("guided route — surveyed altitude outliers do not become ledges", () => {
  const MAX_GRADE = 0.05;

  function steepestGrade(metric) {
    let worst = 0;
    for (const edgeId of metric.usedEdgeIds) {
      const edge = metric.graph.edges[edgeId];
      const a = metric.graph.nodes[edge.a], b = metric.graph.nodes[edge.b];
      if (a.altitude == null || b.altitude == null) continue;
      const length = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
      if (!(length > 1e-6)) continue;
      const grade = Math.abs(b.altitude - a.altitude) / length;
      if (grade > worst) worst = grade;
    }
    return { grade: worst };
  }

  // The surveyed 2026 skidpad really does carry this defect: four cones at the
  // entry and exit arm tips sit ~0.3 m below a pad otherwise flat to 0.15 m.
  it("the fixture still contains the outlier cones this guards against", () => {
    const { cones } = measuredSkidpadFixture();
    const alts = cones.map((cone) => cone.alt).sort((a, b) => a - b);
    const low = quantile(alts, 0.02), median = quantile(alts, 0.5), high = quantile(alts, 0.9);
    assert.ok(median - low > 0.25, `expected a >0.25 m outlier, got ${(median - low).toFixed(3)} m`);
    assert.ok(high - quantile(alts, 0.1) < 0.2, "the rest of the pad should be near flat");
  });

  it("bounds the longitudinal grade over the whole route", () => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    const route = computeGuidedRoute(cones, markers, steps, { step: 1.0 });
    const { grade } = steepestGrade(route.metric);
    assert.ok(grade <= MAX_GRADE + 1e-6, `steepest grade ${(grade * 100).toFixed(1)}% exceeds the ${MAX_GRADE * 100}% limit`);
  });

  it("leaves relief that is already within the limit exactly as surveyed", () => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    // A 3% ramp across the pad: under the limit, so nothing may be clamped.
    const ramped = cones.map((cone) => ({ ...cone, alt: cone.alt + 0.03 * (cone.lat - cones[0].lat) * 110540 }));
    const plain = computeGuidedRoute(cones, markers, steps, { step: 1.0 });
    const sloped = computeGuidedRoute(ramped, markers, steps, { step: 1.0 });

    const rise = (metric) => {
      const alts = metric.graph.nodes.map((n) => n.altitude).filter((v) => v != null);
      return Math.max(...alts) - Math.min(...alts);
    };
    assert.ok(rise(sloped.metric) > rise(plain.metric) + 0.3, "an added ramp must survive the grade limit");
    const { grade } = steepestGrade(sloped.metric);
    assert.ok(grade <= MAX_GRADE + 1e-6, `ramped course grade ${(grade * 100).toFixed(1)}%`);
  });

  it("still produces a drivable model on a course with no altitudes at all", () => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    const flat = cones.map(({ alt, ...rest }) => rest);
    const route = computeGuidedRoute(flat, markers, steps, { step: 1.0 });
    const track = buildGuidedTrackModel(route, flat, { name: "flat" });
    assert.ok(route.metric.z.every((z) => Number.isFinite(z)));
    assert.ok(track.surface.triangles > 0);
  });
});
