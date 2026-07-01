import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  writeKn5,
  readKn5,
  meshNode,
  dummyNode,
  translationMatrix,
  IDENTITY,
} from "../../course/lib/kn5.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name));

// Rebuild the exact kn5.py __main__ self-test geometry. The texture blob is the
// committed bytes Python embedded (kn5_selftest_tex.bin) so the two files carry
// byte-identical texture data regardless of zlib runtime differences.
function selfTest() {
  const tex = [["asphalt.png", new Uint8Array(fixture("kn5_selftest_tex.bin"))]];
  const mats = [{
    name: "road_mat",
    shader: "ksPerPixel",
    props: [
      ["ksDiffuse", 0.4, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
      ["ksAmbient", 0.4, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
    ],
    textures: [["txDiffuse", "asphalt.png"]],
  }];
  const pos = [[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]];
  const nrm = [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const road = meshNode("1ROAD", pos, nrm, uv, [0, 1, 2, 0, 2, 3], 0);
  const pit = dummyNode("AC_PIT_0", translationMatrix([0, 0, 0]));
  const start = dummyNode("AC_START_0", translationMatrix([0, 0, 3]));
  const root = dummyNode("track", IDENTITY, [road, pit, start]);
  return { textures: tex, materials: mats, root };
}

describe("kn5 writer — byte parity", () => {
  it("writes bytes identical to the Python golden", () => {
    const got = writeKn5(selfTest());
    const golden = new Uint8Array(fixture("kn5_selftest.bin"));
    assert.equal(got.byteLength, golden.byteLength, "file size mismatch");
    assert.ok(Buffer.from(got).equals(Buffer.from(golden)), "kn5 bytes differ from golden");
  });
});

describe("kn5 reader — round-trip", () => {
  const bytes = writeKn5(selfTest());
  const got = readKn5(bytes);

  it("consumes every byte (leftover === 0)", () => {
    assert.equal(got.leftover, 0);
  });

  it("reports version 5", () => {
    assert.equal(got.version, 5);
  });

  it("round-trips textures and materials", () => {
    assert.deepEqual(got.textures, [["asphalt.png", fixture("kn5_selftest_tex.bin").byteLength]]);
    assert.equal(got.materials[0].name, "road_mat");
    assert.equal(got.materials[0].shader, "ksPerPixel");
    assert.deepEqual(got.materials[0].textures, [["txDiffuse", "asphalt.png"]]);
  });

  it("round-trips the node tree names and mesh info", () => {
    assert.deepEqual(got.nodes.map((n) => n.name), ["track", "1ROAD", "AC_PIT_0", "AC_START_0"]);
    const road = got.nodes.find((n) => n.name === "1ROAD");
    assert.equal(road.vertices, 4);
    assert.equal(road.indices, 6);
    assert.equal(road.materialId, 0);
  });
});

describe("kn5 writer — guards", () => {
  it("rejects a mesh with more than 65536 vertices", () => {
    const n = 65537;
    const pos = Array.from({ length: n }, () => [0, 0, 0]);
    const node = meshNode("big", pos, pos, pos.map(() => [0, 0]), [], 0);
    const root = dummyNode("track", IDENTITY, [node]);
    assert.throws(() => writeKn5({ textures: [], materials: [], root }), /exceeds 65536/);
  });
});
