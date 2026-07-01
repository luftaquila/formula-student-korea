import { describe, it } from "node:test";
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

describe("computeCenterline — reference courses", () => {
  for (const ref of REFERENCE) {
    describe(ref.fixture, () => {
      const cones = loadFixture(ref.fixture).cones;
      const result = computeCenterline(cones, { step: 1.0 });

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

      it("is deterministic", () => {
        const again = computeCenterline(cones, { step: 1.0 });
        assert.equal(again.length.toFixed(3), result.length.toFixed(3));
        assert.equal(again.points.length, result.points.length);
      });

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

describe("computeCenterline — start + reverse", () => {
  const cones = loadFixture("endurance").cones;
  const base = computeCenterline(cones, { step: 1.0 });

  it("reverse flips direction but keeps the start point and length", () => {
    const rev = computeCenterline(cones, { step: 1.0, reverse: true });
    assert.ok(haversine(rev.points[0], base.points[0]) < 0.5, "start moved");
    assert.ok(Math.abs(rev.length - base.length) < 1.0, "length changed");
    // reverse's 2nd point == forward's last distinct point (the opposite neighbour)
    const fwdPrev = base.points[base.points.length - 2];
    assert.ok(haversine(rev.points[1], fwdPrev) < 1.5, "direction not reversed");
  });

  it("start rotates the loop to the station nearest a chosen cone", () => {
    // farthest wall cone from the default start -> guaranteed to move the start
    let far = cones[0], fd = -1;
    for (const c of cones.filter((c) => c.side !== "center")) {
      const d = haversine(base.points[0], c);
      if (d > fd) { fd = d; far = c; }
    }
    const r = computeCenterline(cones, { step: 1.0, start: { lat: far.lat, lng: far.lng } });
    // points[0] is the closest station to the chosen cone
    let minI = 0, minD = Infinity;
    for (let i = 0; i < r.points.length - 1; i++) {
      const d = haversine(r.points[i], far);
      if (d < minD) { minD = d; minI = i; }
    }
    assert.equal(minI, 0, "start is not the nearest station to the chosen cone");
    assert.ok(haversine(r.points[0], base.points[0]) > 10, "start did not move");
    assert.ok(Math.abs(r.length - base.length) < 1.0, "length changed");
  });

  it("start + reverse compose (nearest station start, flipped direction)", () => {
    const cone = cones.find((c) => c.side === "right");
    const s = computeCenterline(cones, { step: 1.0, start: { lat: cone.lat, lng: cone.lng } });
    const sr = computeCenterline(cones, { step: 1.0, start: { lat: cone.lat, lng: cone.lng }, reverse: true });
    assert.ok(haversine(sr.points[0], s.points[0]) < 0.5, "reverse moved the chosen start");
    assert.ok(haversine(sr.points[1], s.points[s.points.length - 2]) < 1.5, "not reversed");
  });
});

describe("computeCenterline — metric frame", () => {
  const result = computeCenterline(loadFixture("endurance").cones, { step: 1.0, metric: true });

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
  const result = computeCenterline(loadFixture("autonomous").cones, { step: 1.0 });

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
