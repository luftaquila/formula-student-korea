import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { resolveCourseRoute, seedOrientationMarkers, ROUTE_MODE } from "../../course/lib/route-mode.mjs";
import { measuredSkidpadFixture } from "./fixtures/measured-skidpad.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

// Markers carry ids in the API; the resolver only needs id + position.
const withIds = (positions) => positions.map((p, i) => ({ id: i + 1, ...p }));

describe("resolveCourseRoute — no markers", () => {
  it("keeps the stored start/direction fallback untouched", () => {
    const { cones } = loadFixture("endurance");
    const fallback = { start: { lat: cones[0].lat, lng: cones[0].lng }, reverse: true };
    const resolved = resolveCourseRoute(cones, [], [], { step: 1, fallback });
    assert.equal(resolved.mode, ROUTE_MODE.AUTO);
    assert.deepEqual(resolved.centerline, computeCenterline(cones, { step: 1, ...fallback }));
  });

  it("treats a single step as no constraint", () => {
    const { cones } = loadFixture("autocross");
    const markers = withIds([{ lat: cones[0].lat, lng: cones[0].lng }]);
    const resolved = resolveCourseRoute(cones, markers, [markers[0].id], { step: 1 });
    assert.equal(resolved.mode, ROUTE_MODE.AUTO);
    assert.deepEqual(resolved.centerline, computeCenterline(cones, { step: 1 }));
  });
});

// The point of the whole exercise: putting markers on an existing course must not
// move a single station. Seed from the stored direction, resolve, and require the
// result to equal what the course produced before markers existed.
describe("seedOrientationMarkers — reproduces stored direction exactly", () => {
  for (const reverse of [false, true]) {
    it(`preserves a representative closed route (reverse=${reverse})`, () => {
      const { cones } = loadFixture("endurance");
      const startCone = cones[0];
      const fallback = { start: { lat: startCone.lat, lng: startCone.lng }, ...(reverse ? { reverse: true } : {}) };
      const expected = computeCenterline(cones, { step: 1, metric: true, ...fallback });

      const seeded = seedOrientationMarkers(cones, { ...fallback, step: 1 });
      assert.ok(seeded, "seeding must produce markers for a closed loop");
      assert.equal(seeded.length, 2);

      const markers = withIds(seeded);
      const resolved = resolveCourseRoute(cones, markers, markers.map((m) => m.id), { step: 1, metric: true });

      assert.equal(resolved.mode, ROUTE_MODE.ORIENTED, "a plain loop must stay on the legacy engine");
      assert.equal(resolved.reverse, reverse);
      assert.deepEqual(resolved.centerline, expected);
    });
  }

  it("declines to seed a course the loop reducer cannot close", () => {
    // Three cones per side is the documented floor; below it there is no loop to
    // orient, so seeding must report that instead of inventing markers.
    const cones = [
      { id: 1, lat: 35.292, lng: 126.574, side: "left" },
      { id: 2, lat: 35.2921, lng: 126.574, side: "right" },
    ];
    assert.equal(seedOrientationMarkers(cones, { step: 1 }), null);
  });
});

describe("resolveCourseRoute — orientation from hand-placed markers", () => {
  it("reads travel direction from the shorter arc of the first hop", () => {
    const { cones } = loadFixture("endurance");
    const forward = computeCenterline(cones, { step: 1 });
    assert.ok(forward.closed);
    const n = forward.points.length - 1;

    // Second marker a third of the way round in travel order -> forward.
    const fwd = withIds([forward.points[0], forward.points[Math.floor(n / 3)]]);
    const fwdResolved = resolveCourseRoute(cones, fwd, fwd.map((m) => m.id), { step: 1 });
    assert.equal(fwdResolved.mode, ROUTE_MODE.ORIENTED);
    assert.equal(fwdResolved.reverse, false);

    // Two thirds round is the shorter arc the other way -> reversed.
    const rev = withIds([forward.points[0], forward.points[Math.floor((2 * n) / 3)]]);
    const revResolved = resolveCourseRoute(cones, rev, rev.map((m) => m.id), { step: 1 });
    assert.equal(revResolved.mode, ROUTE_MODE.ORIENTED);
    assert.equal(revResolved.reverse, true);
    assert.deepEqual(
      revResolved.centerline,
      computeCenterline(cones, { step: 1, start: forward.points[0], reverse: true }),
    );
  });

  it("accepts three markers sweeping one way and rejects an order that doubles back", () => {
    const { cones } = loadFixture("autocross");
    const cl = computeCenterline(cones, { step: 1 });
    assert.ok(cl.closed);
    const n = cl.points.length - 1;
    const at = (frac) => cl.points[Math.floor(n * frac)];

    const sweep = withIds([at(0), at(1 / 3), at(2 / 3)]);
    const ok = resolveCourseRoute(cones, sweep, sweep.map((m) => m.id), { step: 1 });
    assert.equal(ok.mode, ROUTE_MODE.ORIENTED);
    assert.equal(ok.reverse, false);

    // The same stations in descending order are still one sweep — the reversed
    // one — so orientation must recognise it rather than reach for the router.
    const descending = withIds([at(0), at(2 / 3), at(1 / 3)]);
    const backwards = resolveCourseRoute(cones, descending, descending.map((m) => m.id), { step: 1 });
    assert.equal(backwards.mode, ROUTE_MODE.ORIENTED);
    assert.equal(backwards.reverse, true);

    // Doubling back: the third stop sits behind the second in the direction the
    // first hop established, so no single lap visits them in this order. That
    // leaves the router, which reports it cannot join them on this cone field.
    const zigzag = withIds([at(0), at(1 / 3), at(1 / 6)]);
    assert.throws(() => resolveCourseRoute(cones, zigzag, zigzag.map((m) => m.id), { step: 1 }), /마커/);
  });

  it("closing back onto the opening marker still counts as one sweep", () => {
    const { cones } = loadFixture("endurance");
    const cl = computeCenterline(cones, { step: 1 });
    const n = cl.points.length - 1;
    const markers = withIds([cl.points[0], cl.points[Math.floor(n / 3)], cl.points[Math.floor((2 * n) / 3)]]);
    const steps = [...markers.map((m) => m.id), markers[0].id];
    const resolved = resolveCourseRoute(cones, markers, steps, { step: 1 });
    assert.equal(resolved.mode, ROUTE_MODE.ORIENTED);
    assert.equal(resolved.reverse, false);
  });
});

describe("resolveCourseRoute — falls through to the graph router", () => {
  it("hands a repeated visit to the router, which asks for an intermediate marker", () => {
    const { cones } = loadFixture("endurance");
    const cl = computeCenterline(cones, { step: 1 });
    const n = cl.points.length - 1;
    const markers = withIds([cl.points[0], cl.points[Math.floor(n / 3)]]);
    // Visiting the second marker twice re-uses pavement, so this is never an
    // orientation. Two markers cannot say which way each lap runs, and the
    // router says exactly that instead of the resolver guessing a lap for it.
    const steps = [markers[0].id, markers[1].id, markers[0].id, markers[1].id];
    assert.throws(
      () => resolveCourseRoute(cones, markers, steps, { step: 1 }),
      /마커/,
      "the guided router's own diagnostic must reach the caller",
    );
  });

  it("routes markers placed off the road through the guided engine", () => {
    const { cones } = loadFixture("endurance");
    const cl = computeCenterline(cones, { step: 1 });
    const n = cl.points.length - 1;
    // ~500 m north of the course: no station can claim it.
    const offRoad = { lat: cl.points[Math.floor(n / 3)].lat + 0.0045, lng: cl.points[Math.floor(n / 3)].lng };
    const markers = withIds([cl.points[0], offRoad]);
    assert.throws(() => resolveCourseRoute(cones, markers, markers.map((m) => m.id), { step: 1 }));
  });

  it("keeps the measured skidpad walk on the guided engine", () => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    const resolved = resolveCourseRoute(cones, markers, steps, { step: 1, metric: true });
    assert.equal(resolved.mode, ROUTE_MODE.GUIDED);
    assert.ok(resolved.centerline.ok);
    // The router's own output, not an orientation of a reduced loop.
    assert.ok(Array.isArray(resolved.centerline.metric.routeNodeIds));
    assert.equal(resolved.reverse, false);
  });
});
