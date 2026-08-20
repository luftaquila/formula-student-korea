import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { buildRoadEdges } from "../../course/lib/road-edges.mjs";
import { buildTrackModel } from "../../course/lib/track-build.mjs";

const expected = {
  endurance: {
    length: 850.7040237009775, points: 853,
    kn5: "bc5ff4645059c92548c82417015f35c52da2613a8010b867f6ad04adc2c5781a",
    ai: "7a396fcb354de9c0871207e522ba0ab2ee2c4fa645dd4d968addc4f21a797201",
  },
  endurance_2026: {
    length: 870.4829736963578, points: 873,
    kn5: "7b7606949ece32e9348d981bf8c14b7c5b8732dc916cf391815231e773d79ea8",
    ai: "52607f8eb5c3a98bcb713b635ac8479539fb571930ea400752c38242abf660a0",
  },
  autocross: {
    length: 855.0224871134858, points: 858,
    kn5: "92a6b88ea8d7ef58e89a015c1f63ab4197f2fe586f527fb417e22d6f1eba4e6f",
    ai: "dce26e0af246a8972bb6f271898828f091629b0d0bcc727948400604a201482c",
  },
  autonomous: {
    length: 250.66427288996098, points: 251,
    kn5: "33e1accb5cc4a5fec7ae0e40960b3d778ca2c9d04350570f9f568b4c826fff3d",
    ai: "35a4aa8fd5470bd4a0b708ebfec6c32cf9755b9b3074f20c3f5b03b747fec479",
  },
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

describe("legacy automatic centerline regression", () => {
  for (const [name, golden] of Object.entries(expected)) {
    it(`keeps ${name} centerline, KN5, and AI byte-identical without route markers`, () => {
      const fixture = JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
      const centerline = computeCenterline(fixture.cones, { step: 1, metric: true });
      const edges = buildRoadEdges(centerline);
      const track = buildTrackModel(centerline, edges, { name });

      assert.equal(centerline.length, golden.length);
      assert.equal(centerline.points.length, golden.points);
      assert.equal(sha256(track.kn5), golden.kn5);
      assert.equal(sha256(track.ai), golden.ai);
    });
  }
});
