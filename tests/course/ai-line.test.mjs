import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { writeFastLane, readFastLane } from "../../course/lib/ai-line.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name));

const input = JSON.parse(fixture("ai_fixed_input.json").toString("utf8"));

describe("ai-line writer — byte parity", () => {
  it("writes bytes identical to the Python golden (camber = 0)", () => {
    const got = writeFastLane(input); // no camber -> all zeros, matches ai_line.py
    const golden = new Uint8Array(fixture("ai_fixed.bin"));
    assert.equal(got.byteLength, golden.byteLength, "file size mismatch");
    assert.ok(Buffer.from(got).equals(Buffer.from(golden)), "ai bytes differ from golden");
  });
});

describe("ai-line reader — round-trip", () => {
  const bytes = writeFastLane(input);
  const got = readFastLane(bytes);

  it("consumes every byte (leftover === 0)", () => {
    assert.equal(got.leftover, 0);
  });

  it("reports version 7 and matching point/extra counts", () => {
    assert.equal(got.version, 7);
    assert.equal(got.count, input.positions.length);
    assert.equal(got.extraCount, input.positions.length);
  });

  it("has a spatial grid with 10 neighbors per cell", () => {
    assert.equal(got.hasGrid, 1);
    assert.equal(got.grid.neighbors, Math.min(10, input.positions.length));
    assert.ok(got.grid.nx >= 1 && got.grid.nz >= 1);
  });
});

describe("ai-line writer — camber extension", () => {
  it("non-zero camber changes the bytes vs zero camber", () => {
    const zero = writeFastLane(input);
    const withCamber = writeFastLane({ ...input, camber: input.positions.map((_, i) => 0.05 * i) });
    assert.equal(zero.byteLength, withCamber.byteLength);
    assert.ok(!Buffer.from(zero).equals(Buffer.from(withCamber)), "camber had no effect");
  });
});
