import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  computeCenterline,
  centerlineToGeoJSON,
} from "../../course/lib/centerline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

// Reference lengths produced by the scipy centerline.py for the same cone data.
// The port should land within tolerance (it is not byte-identical because the
// slalom pass approximates FITPACK's smoothing spline with Catmull-Rom).
const REFERENCE = [
  { fixture: "endurance", name: "내구", length: 850.3 },
  { fixture: "autocross", name: "오토크로스", length: 854.9 },
  { fixture: "autonomous", name: "자율주행", length: 251.3 },
];

const R = 6371e3;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Max turn angle (deg) between consecutive centerline segments, over the closed
// loop. Projects lat/lng to local metres about the mean latitude (equirectangular)
// so the angle is measured in the metric plane the track actually lives in.
function maxTurnAngleDeg(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const mlat = 110540, mlng = 111320 * Math.cos(rad(lat0));
  const P = points.map((p) => [p.lng * mlng, p.lat * mlat]);
  const n = P.length;
  let maxA = 0;
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const m1 = Math.hypot(v1[0], v1[1]), m2 = Math.hypot(v2[0], v2[1]);
    if (m1 < 1e-9 || m2 < 1e-9) continue;
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2)));
    const ang = (Math.acos(cos) * 180) / Math.PI;
    if (ang > maxA) maxA = ang;
  }
  return maxA;
}

// Count self-intersections of the closed centerline in the metric plane. A valid
// track line never crosses itself; a doubled-back / mis-connected loop does.
function selfIntersections(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const mlat = 110540, mlng = 111320 * Math.cos(rad(lat0));
  const P = points.map((p) => [p.lng * mlng, p.lat * mlat]);
  const seg = (p1, p2, p3, p4) => {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  };
  let hits = 0;
  for (let i = 0; i < P.length - 1; i++) {
    for (let j = i + 2; j < P.length - 1; j++) {
      if (i === 0 && j === P.length - 2) continue; // adjacent at the closing seam
      if (seg(P[i], P[i + 1], P[j], P[j + 1])) hits++;
    }
  }
  return hits;
}

describe("computeCenterline — reference courses", () => {
  for (const ref of REFERENCE) {
    describe(ref.fixture, () => {
      let cones, result;

      before(() => {
        cones = loadFixture(ref.fixture).cones;
        result = computeCenterline(cones, { step: 1.0 });
      });

      it("computes an ok, closed loop", () => {
        assert.equal(result.ok, true);
        assert.equal(result.closed, true);
      });

      it("matches the scipy reference length within 8%", () => {
        const err = Math.abs(result.length - ref.length) / ref.length;
        assert.ok(
          err < 0.08,
          `length ${result.length.toFixed(1)}m vs ref ${ref.length}m (${(err * 100).toFixed(1)}%)`,
        );
      });

      it("returns finite lat/lng points spaced ~1m", () => {
        assert.ok(result.points.length > 50);
        // ~1m spacing -> point count is close to the length in metres
        assert.ok(Math.abs(result.points.length - result.length) < 15);
        for (const p of result.points) {
          assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng));
        }
      });

      it("stays off the track walls (left/right clearance > 0.3m)", () => {
        // The line legitimately threads through center (slalom) cones, so this
        // only checks clearance to the wall cones that mark the track edges.
        const walls = cones.filter((c) => c.side === "left" || c.side === "right");
        let minClearance = Infinity;
        for (const p of result.points) {
          for (const c of walls) {
            const d = haversine(p, c);
            if (d < minClearance) minClearance = d;
          }
        }
        assert.ok(minClearance > 0.3, `min wall clearance ${minClearance.toFixed(2)}m`);
      });

      if (ref.fixture === "autonomous") {
        it("is deterministic for identical input", () => {
          assert.deepEqual(computeCenterline(cones, { step: 1.0 }), result);
        });
      }

      // Smoothness gate — the reason the slalom pass uses a Reinsch smoothing
      // spline instead of an interpolating Catmull-Rom: guarantees no small
      // per-vertex kinks ("삐침"), especially at slalom entry/exit. A hard
      // regression tripwire if the smoothing is ever weakened or reverted.
      it("has no sharp per-vertex kink (max turn angle <= 25°)", () => {
        const maxA = maxTurnAngleDeg(result.points);
        assert.ok(maxA <= 25, `max turn angle ${maxA.toFixed(1)}° exceeds 25°`);
      });
    });
  }
});

// Regression for the FSK 2026 Endurance course, which exercised two defects on
// the right side of the track:
//   1. A stretch coned on ONLY the right side (no left wall for ~5 cones). With
//      no left/right Delaunay crossings the medial graph could not trace it, so
//      the loop jumped across the missing wall — routing through unrelated center
//      cones and cutting through the far wall instead of following the lone wall.
//      virtualOppositeWall() now synthesises the missing wall so the line follows
//      the single-wall corridor at half width.
//   2. That mis-route made the narrow middle junction a slalom threaded on TWO
//      passes of the loop; snapSlaloms' GLOBAL nearest-station endpoint match then
//      landed the group's two ends on opposite passes and excised the arc between
//      them, collapsing the ~871 m loop to ~449 m (the entire bottom half). The
//      local-window anchor in snapSlaloms keeps both ends on the same pass.
// The assertions below guard the full loop, its smoothness, and that it neither
// self-crosses nor cuts a wall.
describe("computeCenterline — FSK 2026 Endurance regression", () => {
  let cones, result;

  before(() => {
    cones = loadFixture("endurance_2026").cones;
    result = computeCenterline(cones, { step: 1.0 });
  });

  it("computes an ok, closed loop that covers the whole track", () => {
    assert.equal(result.ok, true);
    assert.equal(result.closed, true);
    // The excision produced ~449 m (half the loop); the intact loop is ~871 m.
    assert.ok(
      result.length > 800,
      `length ${result.length.toFixed(1)}m — loop truncated?`,
    );
  });

  it("returns ~1m-spaced points and stays off the walls", () => {
    assert.ok(Math.abs(result.points.length - result.length) < 15);
    const walls = cones.filter((c) => c.side === "left" || c.side === "right");
    let minClearance = Infinity;
    for (const p of result.points) {
      for (const c of walls) {
        const d = haversine(p, c);
        if (d < minClearance) minClearance = d;
      }
    }
    // Following the single wall keeps the line centred (>0.5 m); the mis-route
    // squeezed the doubled junction to ~0.39 m before the fix.
    assert.ok(minClearance > 0.5, `min wall clearance ${minClearance.toFixed(2)}m`);
  });

  it("does not self-cross or kink at the single-wall junction", () => {
    assert.equal(selfIntersections(result.points), 0, "centerline crosses itself");
    const maxA = maxTurnAngleDeg(result.points);
    assert.ok(maxA <= 25, `max turn angle ${maxA.toFixed(1)}° exceeds 25°`);
  });

  it("follows every wall instead of cutting across a single-wall section", () => {
    // When single-wall tracing fails the line jumps across the gap, leaving that
    // wall's cones ~3x the ~4.2 m track width away. Every real wall cone must have
    // a centerline point within ~2x width. Skip isolated stray cones in the data
    // (no same-side neighbour within ~3x width) which are legitimately far.
    const walls = cones.filter((c) => c.side === "left" || c.side === "right");
    const isStray = (c) => {
      let m = Infinity;
      for (const o of walls) {
        if (o === c || o.side !== c.side) continue;
        const d = haversine(c, o);
        if (d < m) m = d;
      }
      return m > 13;
    };
    let worst = 0;
    for (const c of walls) {
      if (isStray(c)) continue;
      let m = Infinity;
      for (const p of result.points) {
        const d = haversine(p, c);
        if (d < m) m = d;
      }
      if (m > worst) worst = m;
    }
    assert.ok(worst < 8, `a wall cone is ${worst.toFixed(1)}m from the line — cut across?`);
  });

});

describe("computeCenterline — start + reverse", () => {
  let cones, base, far, reversed, started, startedReversed;

  before(() => {
    cones = loadFixture("endurance").cones;
    base = computeCenterline(cones, { step: 1.0 });
    far = cones
      .filter((cone) => cone.side !== "center")
      .reduce((farthest, cone) =>
        haversine(base.points[0], cone) > haversine(base.points[0], farthest) ? cone : farthest
      );
    reversed = computeCenterline(cones, { step: 1.0, reverse: true });
    started = computeCenterline(cones, { step: 1.0, start: { lat: far.lat, lng: far.lng } });
    startedReversed = computeCenterline(cones, {
      step: 1.0,
      start: { lat: far.lat, lng: far.lng },
      reverse: true,
    });
  });

  it("reverse flips direction but keeps the start point and length", () => {
    assert.ok(haversine(reversed.points[0], base.points[0]) < 0.5, "start moved");
    assert.ok(Math.abs(reversed.length - base.length) < 1.0, "length changed");
    // reverse's 2nd point == forward's last distinct point (the opposite neighbour)
    const fwdPrev = base.points[base.points.length - 2];
    assert.ok(haversine(reversed.points[1], fwdPrev) < 1.5, "direction not reversed");
  });

  it("start rotates the loop to the station nearest a chosen cone", () => {
    // points[0] is the closest station to the chosen cone
    let minI = 0, minD = Infinity;
    for (let i = 0; i < started.points.length - 1; i++) {
      const d = haversine(started.points[i], far);
      if (d < minD) { minD = d; minI = i; }
    }
    assert.equal(minI, 0, "start is not the nearest station to the chosen cone");
    assert.ok(haversine(started.points[0], base.points[0]) > 10, "start did not move");
    assert.ok(Math.abs(started.length - base.length) < 1.0, "length changed");
  });

  it("start + reverse compose (nearest station start, flipped direction)", () => {
    assert.ok(haversine(startedReversed.points[0], started.points[0]) < 0.5, "reverse moved the chosen start");
    assert.ok(haversine(startedReversed.points[1], started.points[started.points.length - 2]) < 1.5, "not reversed");
  });
});

describe("computeCenterline — metric frame", () => {
  let result;

  before(() => {
    result = computeCenterline(loadFixture("endurance").cones, { step: 1.0, metric: true });
  });

  it("attaches a single shared projection frame", () => {
    assert.ok(result.metric);
    assert.equal(result.metric.mlat, 110540);
    assert.ok(Number.isFinite(result.metric.lat0) && Number.isFinite(result.metric.lng0));
    assert.ok(Number.isFinite(result.metric.mlng));
    assert.ok(result.metric.width > 0);
  });

  it("carries metric station + cone arrays, all finite", () => {
    const { P, left, right, centers } = result.metric;
    assert.ok(P.length > 50);
    // stations are de-duplicated (no closing duplicate) for the road pipeline
    assert.ok(Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) > 1e-6);
    for (const arr of [P, left, right, centers]) {
      for (const [x, y] of arr) assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
    assert.ok(left.length >= 3 && right.length >= 3);
  });

  it("gives each centerline point a finite positive width", () => {
    for (const p of result.points) assert.ok(Number.isFinite(p.width) && p.width > 0);
  });

  it("omits metric unless requested", () => {
    const plain = computeCenterline(loadFixture("endurance").cones, { step: 1.0 });
    assert.equal(plain.metric, undefined);
  });
});

describe("exporters", () => {
  let result;

  before(() => {
    result = computeCenterline(loadFixture("autonomous").cones, { step: 1.0 });
  });

  it("centerlineToGeoJSON produces a LineString Feature", () => {
    const gj = centerlineToGeoJSON(result, { name: "자율주행" });
    assert.equal(gj.type, "Feature");
    assert.equal(gj.geometry.type, "LineString");
    assert.equal(gj.properties.name, "자율주행");
    assert.equal(gj.properties.closed, true);
    assert.ok(typeof gj.properties.length_m === "number");
    assert.equal(gj.geometry.coordinates.length, result.points.length);
    // GeoJSON order is [lng, lat]
    assert.deepEqual(gj.geometry.coordinates[0], [result.points[0].lng, result.points[0].lat]);
  });

  it("centerlineToGeoJSON returns null for a failed result", () => {
    assert.equal(centerlineToGeoJSON({ ok: false, reason: "x" }), null);
  });
});

describe("computeCenterline — guards", () => {
  it("rejects a course with fewer than 3 left and 3 right cones", () => {
    const cones = [
      { lat: 0, lng: 0, side: "left" },
      { lat: 0, lng: 0.0001, side: "left" },
      { lat: 0.0001, lng: 0, side: "right" },
      { lat: 0.0001, lng: 0.0001, side: "right" },
      { lat: 0.0002, lng: 0, side: "right" },
      { lat: 0.0002, lng: 0.0001, side: "right" },
    ];
    const r = computeCenterline(cones);
    assert.equal(r.ok, false);
    assert.match(r.reason, /3 left and 3 right/);
  });

  it("rejects too few cones outright", () => {
    const r = computeCenterline([{ lat: 0, lng: 0, side: "left" }]);
    assert.equal(r.ok, false);
  });
});
