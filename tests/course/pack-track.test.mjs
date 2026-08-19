import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeCenterline } from "../../course/lib/centerline.mjs";
import { buildRoadEdges } from "../../course/lib/road-edges.mjs";
import { buildTrackModel } from "../../course/lib/track-build.mjs";
import { packTrackEntries, SURFACES_INI, safeTrackName } from "../../course/lib/pack-track.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));

const NAME = "내구";
const cones = loadFixture("endurance").cones;
const cl = computeCenterline(cones, { step: 1.0, metric: true });
const edges = buildRoadEdges(cl);
const track = buildTrackModel(cl, edges, { name: NAME });
// packTrackEntries returns a { path -> string|Uint8Array } map; the caller zips
// it (JSZip in the browser). The test asserts the map directly so it stays
// dependency-free — the actual zipping is covered by the app build + browser E2E.
const entries = packTrackEntries(cl, edges, track, { name: NAME });

const root = `content/tracks/${NAME}`;
const EXPECTED = [
  `${root}/${NAME}.kn5`,
  `${root}/models.ini`,
  `${root}/data/surfaces.ini`,
  `${root}/data/map.ini`,
  `${root}/data/ideal_line.ai`,
  `${root}/ai/fast_lane.ai`,
  `${root}/map.png`,
  `${root}/ui/ui_track.json`,
  `${root}/ui/outline.png`,
  `${root}/ui/preview.png`,
].sort();

describe("packTrackEntries — tree", () => {
  it("produces exactly the AC track file tree", () => {
    assert.deepEqual(Object.keys(entries).sort(), EXPECTED);
  });
});

describe("packTrackEntries — name safety", () => {
  it("safeTrackName replaces whitespace runs with a single dash", () => {
    assert.equal(safeTrackName("Yeongam  Circuit"), "Yeongam-Circuit");
    assert.equal(safeTrackName("내구 코스"), "내구-코스");
  });

  it("uses the safe name for paths but keeps the display name in ui_track.json", () => {
    const display = "내구 코스";
    const safe = safeTrackName(display);
    const e = packTrackEntries(cl, edges, track, { name: safe, uiName: display });
    assert.ok(e[`content/tracks/${safe}/${safe}.kn5`], "kn5 path not safe-named");
    assert.ok(e[`content/tracks/${safe}/models.ini`], "models.ini path not safe-named");
    assert.equal(e[`content/tracks/${safe}/models.ini`], `[MODEL_0]\nFILE=${safe}.kn5\nPOSITION=0,0,0\nROTATION=0,0,0\n`);
    assert.equal(JSON.parse(e[`content/tracks/${safe}/ui/ui_track.json`]).name, display);
  });
});

describe("packTrackEntries — text files", () => {
  it("surfaces.ini is byte-identical to the reference", () => {
    assert.equal(entries[`${root}/data/surfaces.ini`], SURFACES_INI);
  });

  it("surfaces.ini defaults ROAD grip to 1.05 and keeps GRASS at 0.7", () => {
    const ini = entries[`${root}/data/surfaces.ini`];
    const section = (key) => ini.split(/\n\n/).find((s) => s.includes(`KEY=${key}`));
    assert.match(section("ROAD"), /^FRICTION=1\.05$/m);
    assert.match(section("GRASS"), /^FRICTION=0\.7$/m);
  });

  it("models.ini references the kn5", () => {
    assert.equal(entries[`${root}/models.ini`],
      `[MODEL_0]\nFILE=${NAME}.kn5\nPOSITION=0,0,0\nROTATION=0,0,0\n`);
  });

  it("map.ini has the AC minimap format (SCALE_FACTOR=1, right precision)", () => {
    const ini = entries[`${root}/data/map.ini`];
    const kv = Object.fromEntries(ini.trim().split("\n").filter((l) => l.includes("=")).map((l) => l.split("=")));
    assert.ok(ini.startsWith("[PARAMETERS]\n"));
    assert.equal(kv.MARGIN, "20");
    assert.equal(kv.MAX_SIZE, "1600");
    assert.equal(kv.DRAWING_SIZE, "10");
    assert.equal(kv.SCALE_FACTOR, "1");            // small course -> 1 px/m
    assert.match(kv.WIDTH, /^\d+\.\d{3}$/);
    assert.match(kv.HEIGHT, /^\d+\.\d{3}$/);
    assert.match(kv.X_OFFSET, /^-?\d+\.\d{6}$/);
    assert.match(kv.Z_OFFSET, /^-?\d+\.\d{6}$/);
  });

  it("ui_track.json carries the expected metadata", () => {
    const ui = JSON.parse(entries[`${root}/ui/ui_track.json`]);
    assert.equal(ui.name, NAME);
    assert.equal(ui.run, "clockwise");
    assert.equal(ui.author, "luftaquila");
    assert.equal(ui.pitboxes, "1");
    assert.deepEqual(ui.tags, ["circuit", "autogen", "cones"]);
    assert.match(ui.length, /^\d+$/);
    assert.match(ui.width, /^\d+\.\d$/);
  });
});

describe("packTrackEntries — ai + binaries", () => {
  it("ideal_line.ai == fast_lane.ai == the built ai bytes", () => {
    const ideal = entries[`${root}/data/ideal_line.ai`];
    const fast = entries[`${root}/ai/fast_lane.ai`];
    assert.ok(Buffer.from(ideal).equals(Buffer.from(fast)));
    assert.ok(Buffer.from(fast).equals(Buffer.from(track.ai)));
  });

  it("embeds the kn5 bytes unchanged", () => {
    assert.ok(Buffer.from(entries[`${root}/${NAME}.kn5`]).equals(Buffer.from(track.kn5)));
  });

  it("map/outline/preview are valid PNGs", () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const p of [`${root}/map.png`, `${root}/ui/outline.png`, `${root}/ui/preview.png`]) {
      assert.deepEqual(Array.from(entries[p].subarray(0, 8)), sig, `${p} not a PNG`);
    }
  });
});
