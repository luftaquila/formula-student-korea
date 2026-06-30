import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  computeCenterline,
  centerlineToGeoJSON,
} from "../../shared/centerline.mjs";

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
    });
  }
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
