import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSideRanks } from "../../course/lib/cone-index.mjs";

// The exact per-cone implementation buildSideRanks replaces (see MapView.vue
// history): rank = count of same-side cones with id <= this cone's id.
function refIndex(cones, coneId) {
  const cone = cones.find((c) => c.id === coneId);
  if (!cone) return 0;
  return cones.filter((c) => c.side === cone.side && c.id <= coneId).length;
}

const cone = (id, side) => ({ id, side, lat: 0, lng: 0 });

describe("buildSideRanks", () => {
  it("returns an empty map for no cones", () => {
    assert.equal(buildSideRanks([]).size, 0);
  });

  it("does not mutate the input array", () => {
    const cones = [cone(3, "left"), cone(1, "left"), cone(2, "left")];
    const order = cones.map((c) => c.id);
    buildSideRanks(cones);
    assert.deepEqual(cones.map((c) => c.id), order, "input order preserved");
  });

  it("matches the original find+filter implementation for every cone", () => {
    // A mixed, deliberately unordered dataset covering all sides.
    const sides = ["left", "center", "right"];
    const cones = [];
    for (let i = 0; i < 200; i++) {
      // pseudo-random but deterministic id/side assignment
      const id = ((i * 37) % 200) + 1;
      cones.push(cone(id, sides[(i * 7) % 3]));
    }
    // de-dup ids (ids are unique in real data)
    const seen = new Set();
    const unique = cones.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

    const r = buildSideRanks(unique);
    for (const c of unique) {
      assert.equal(r.get(c.id), refIndex(unique, c.id), `cone #${c.id} (${c.side})`);
    }
  });
});
