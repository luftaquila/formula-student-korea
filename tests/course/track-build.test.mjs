import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { buildRoadEdges } from "../../course/lib/road-edges.mjs";
import { buildTrackModel } from "../../course/lib/track-build.mjs";
import { readKn5 } from "../../course/lib/kn5.mjs";
import { readFastLane } from "../../course/lib/ai-line.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

const cones = loadFixture("endurance").cones;
const cl = computeCenterline(cones, { step: 1.0, metric: true });
const edges = buildRoadEdges(cl);
const track = buildTrackModel(cl, edges, { name: "내구" });
const N = cl.metric.P.length;

describe("buildTrackModel — kn5 structure", () => {
  const got = readKn5(track.kn5);

  it("is a valid version-5 kn5 with no leftover bytes", () => {
    assert.equal(got.version, 5);
    assert.equal(got.leftover, 0);
  });

  it("has the required AC node tree (incl. per-side cones)", () => {
    // the endurance fixture has left, right and center cones -> CONE_L/R/C
    assert.deepEqual(
      got.nodes.map((n) => n.name),
      ["내구", "1ROAD", "1GRASS", "CONE_L", "CONE_R", "CONE_C",
        "AC_PIT_0", "AC_START_0", "AC_TIME_0_L", "AC_TIME_0_R"],
    );
  });

  it("road/grass meshes reference materials 0/1 with 2N road vertices", () => {
    const road = got.nodes.find((n) => n.name === "1ROAD");
    const grass = got.nodes.find((n) => n.name === "1GRASS");
    assert.equal(road.materialId, 0);
    assert.equal(grass.materialId, 1);
    assert.equal(road.vertices, 2 * N);
    assert.equal(grass.vertices, 4);
  });

  it("cone meshes are graphics-only (non-digit names) with materials 2/3/4", () => {
    for (const [name, mat] of [["CONE_L", 2], ["CONE_R", 3], ["CONE_C", 4]]) {
      const c = got.nodes.find((n) => n.name === name);
      assert.ok(c, `${name} missing`);
      assert.ok(!/^\d/.test(c.name), `${name} must not start with a digit (would collide)`);
      assert.equal(c.materialId, mat);
      assert.ok(c.vertices > 0);
    }
  });

  it("embeds road/grass + per-side cone textures and materials", () => {
    assert.deepEqual(got.textures.map((t) => t[0]),
      ["asphalt.dds", "grass.dds", "cone_L.dds", "cone_R.dds", "cone_C.dds"]);
    assert.deepEqual(got.materials.map((m) => m.name),
      ["road", "grass", "cone_L", "cone_R", "cone_C"]);
  });
});

describe("buildTrackModel — ai line", () => {
  const got = readFastLane(track.ai);

  it("is a valid version-7 ai with a grid and no leftover", () => {
    assert.equal(got.version, 7);
    assert.equal(got.count, N);
    assert.equal(got.extraCount, N);
    assert.equal(got.hasGrid, 1);
    assert.equal(got.leftover, 0);
  });

  it("exposes finite ai arrays of length N", () => {
    for (const key of ["speeds", "radii", "grades", "camber"]) {
      assert.equal(track.aiData[key].length, N);
      assert.ok(track.aiData[key].every((v) => Number.isFinite(v)));
    }
  });

  it("clips speeds to 8–40 m/s and radii to 5–1000 m", () => {
    assert.ok(track.aiData.speeds.every((v) => v >= 8 && v <= 40));
    assert.ok(track.aiData.radii.every((v) => v >= 5 && v <= 1000));
  });
});

describe("buildTrackModel — meta", () => {
  it("reports length close to the centerline, positive widths, clockwise", () => {
    assert.ok(Math.abs(track.meta.length - cl.length) / cl.length < 0.05);
    assert.ok(track.meta.medianWidth > 0 && track.meta.minWidth > 0);
    assert.equal(track.meta.run, "clockwise");
    assert.equal(track.meta.reverse, false);
  });
});

describe("buildTrackModel — determinism", () => {
  it("produces byte-identical kn5 and ai on a second build", () => {
    const again = buildTrackModel(cl, edges, { name: "내구" });
    assert.ok(Buffer.from(again.kn5).equals(Buffer.from(track.kn5)), "kn5 not deterministic");
    assert.ok(Buffer.from(again.ai).equals(Buffer.from(track.ai)), "ai not deterministic");
  });
});

describe("buildTrackModel — banked (alt)", () => {
  it("carries non-zero camber when the course is banked", () => {
    const base = loadFixture("endurance").cones;
    const meanLng = base.reduce((s, c) => s + c.lng, 0) / base.length;
    const tilted = base.map((c) => ({ ...c, alt: 2000 * (c.lng - meanLng) }));
    const cl2 = computeCenterline(tilted, { step: 1.0, metric: true });
    const t2 = buildTrackModel(cl2, buildRoadEdges(cl2), { name: "banked" });
    assert.ok(t2.aiData.camber.some((v) => Math.abs(v) > 1e-3), "no camber on banked course");
  });
});
