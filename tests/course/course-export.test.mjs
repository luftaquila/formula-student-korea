import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { buildRoadEdges } from "../../course/lib/road-edges.mjs";
import { buildTrackModel } from "../../course/lib/track-build.mjs";
import { buildEnrichedJSON } from "../../course/lib/course-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

function pipeline(cones, name, reverse = false) {
  // direction is applied in computeCenterline (single source of truth), exactly
  // like MapView's exportCourse; buildTrackModel then runs forward.
  const cl = computeCenterline(cones, { step: 1.0, metric: true, reverse });
  const edges = buildRoadEdges(cl);
  const track = buildTrackModel(cl, edges, { name });
  const json = buildEnrichedJSON({ name, cones, cl, edges, track });
  return { cl, edges, track, json };
}

describe("buildEnrichedJSON — flat course", () => {
  const cones = loadFixture("endurance").cones;
  const { cl, json } = pipeline(cones, "내구");

  it("keeps name and cones untouched (re-importable)", () => {
    assert.equal(json.name, "내구");
    assert.deepEqual(json.cones, cones);
  });

  it("records the shared projection frame", () => {
    assert.deepEqual(json.projection, {
      lat0: cl.metric.lat0, lng0: cl.metric.lng0, mlat: cl.metric.mlat, mlng: cl.metric.mlng,
    });
    assert.equal(json.projection.mlat, 110540);
  });

  it("centerline / edges / ai arrays share one length and are all finite", () => {
    const n = json.centerline.count;
    assert.equal(json.centerline.points.length, n);
    assert.equal(json.edges.left.length, n);
    assert.equal(json.edges.right.length, n);
    for (const k of ["speeds", "radii", "grades", "camber"]) assert.equal(json.ai[k].length, n);
    for (const p of json.centerline.points) {
      for (const key of ["lat", "lng", "x", "y", "z", "width", "widthL", "widthR", "bank"]) {
        assert.ok(Number.isFinite(p[key]), `centerline.${key} not finite`);
      }
    }
    for (const e of json.edges.left.concat(json.edges.right)) {
      for (const key of ["lat", "lng", "x", "y", "z"]) assert.ok(Number.isFinite(e[key]));
    }
    for (const k of ["speeds", "radii", "grades", "camber"]) {
      assert.ok(json.ai[k].every((v) => Number.isFinite(v)));
    }
  });

  it("is flat: elevation absent, all z and bank zero", () => {
    assert.equal(json.elevation.present, false);
    assert.equal(json.elevation.relief_m, 0);
    assert.ok(json.centerline.points.every((p) => p.z === 0 && p.bank === 0));
    assert.ok(json.edges.left.every((e) => e.z === 0));
    assert.ok(json.edges.right.every((e) => e.z === 0));
  });

  it("records the start point GPS + direction (meta.start)", () => {
    assert.ok(json.meta.start);
    assert.equal(json.meta.start.reverse, false);
    // start GPS is the computed (midpoint/centerline) start point = points[0]
    assert.equal(json.meta.start.lat, json.centerline.points[0].lat);
    assert.equal(json.meta.start.lng, json.centerline.points[0].lng);
    assert.ok(Number.isFinite(json.meta.start.lat) && Number.isFinite(json.meta.start.lng));
  });

  it("serialises to JSON round-trip cleanly", () => {
    const round = JSON.parse(JSON.stringify(json));
    assert.deepEqual(round.cones, cones);
    assert.equal(round.centerline.count, json.centerline.count);
    assert.deepEqual(round.meta.start, json.meta.start);
  });
});

describe("buildEnrichedJSON — reversed course", () => {
  const cones = loadFixture("endurance").cones;
  const fwd = pipeline(cones, "내구", false).json;
  const rev = pipeline(cones, "내구", true).json;

  it("meta.start.reverse reflects the applied direction", () => {
    assert.equal(fwd.meta.start.reverse, false);
    assert.equal(rev.meta.start.reverse, true);
  });

  it("keeps the same start point but flips the travel direction", () => {
    const R = 6371e3, r = (d) => (d * Math.PI) / 180;
    const hav = (a, b) => {
      const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    assert.ok(hav(rev.meta.start, fwd.meta.start) < 0.5, "start moved");
    // reversed second point == forward's last distinct point (opposite neighbour)
    const fp = fwd.centerline.points;
    const rp = rev.centerline.points;
    assert.ok(hav(rp[1], fp[fp.length - 2]) < 1.5, "direction not reversed");
  });
});

describe("buildEnrichedJSON — banked course (alt)", () => {
  const base = loadFixture("endurance").cones;
  const meanLng = base.reduce((s, c) => s + c.lng, 0) / base.length;
  const cones = base.map((c) => ({ ...c, alt: 2000 * (c.lng - meanLng) }));
  const { json } = pipeline(cones, "banked");

  it("reports elevation present with positive relief", () => {
    assert.equal(json.elevation.present, true);
    assert.ok(json.elevation.relief_m > 0);
  });

  it("banks where the two edges differ in altitude", () => {
    let saw = false;
    for (let i = 0; i < json.centerline.points.length; i++) {
      const dz = json.edges.left[i].z - json.edges.right[i].z;
      if (Math.abs(dz) > 0.05) {
        assert.ok(Math.abs(json.centerline.points[i].bank) > 1e-3);
        saw = true;
      }
    }
    assert.ok(saw, "no banking on a tilted course");
  });
});
