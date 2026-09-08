import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildCourseArchive } from "../../course/web/src/export/course-archive.mjs";
import { encodePNG } from "../../course/lib/png.mjs";
import { measuredSkidpadFixture } from "./fixtures/measured-skidpad.mjs";
const requireWeb = createRequire(new URL("../../course/web/package.json", import.meta.url));
const JSZip = requireWeb("jszip");
const course = { id: 1, name: "Race course", reverse: 0, start_cone_id: null };
const memos = [{ lat: 35.29, lng: 126.57, width: 5, height: 3, rotation: 0, content: "PRIVATE_NOTE_SENTINEL" }];
const cones = JSON.parse(readFileSync(new URL("./fixtures/endurance.json", import.meta.url))).cones;
const png = encodePNG(1, 1, new Uint8Array([255, 255, 255, 255]));
const preview = async (...args) => {
  assert.ok(!JSON.stringify(args).includes("PRIVATE_NOTE_SENTINEL"));
  return png;
};

async function unpack(archive) {
  const zip = await JSZip.loadAsync(archive.bytes);
  const jsonName = Object.keys(zip.files).find((name) => name.endsWith(".json"));
  const innerName = Object.keys(zip.files).find((name) => name.endsWith("-track.zip"));
  return { zip, json: JSON.parse(await zip.file(jsonName).async("string")), inner: await JSZip.loadAsync(await zip.file(innerName).async("uint8array")) };
}

test("public circuit ZIP has geometry, preview, installable track and English installation README, without annotations", async () => {
  const archive = await buildCourseArchive({ course, cones, memos }, { renderPreview: preview });
  assert.equal(archive.filename, "Race-course.zip");
  const { zip, json, inner } = await unpack(archive);
  assert.deepEqual(Object.keys(zip.files).sort(), ["README.txt", "Race-course-track.zip", "Race-course.json", "Race-course.png"]);
  assert.equal(Object.hasOwn(json, "memos"), false);
  assert.deepEqual(json.cones, cones);
  assert.ok(json.centerline.points.length > 0);
  assert.ok(!JSON.stringify(json).includes("PRIVATE_NOTE_SENTINEL"));
  assert.equal(Buffer.compare(await zip.file("Race-course.png").async("uint8array"), png), 0);
  assert.ok(inner.file("content/tracks/Race-course/Race-course.kn5"));
  assert.ok(inner.file("content/tracks/Race-course/ai/fast_lane.ai"));
  const readme = await zip.file("README.txt").async("string");
  assert.ok(readme.split("\n").filter((line) => line.startsWith("- ")).length >= 4);
  assert.ok(readme.includes("Race-course-track.zip"));
  assert.ok(readme.includes("content/tracks/Race-course/"));
  assert.ok(readme.includes("Steam/steamapps/common/assettocorsa"));
});

test("operator opt-in preserves memos and identical inputs produce identical archives", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T00:00:00Z") });
  const input = { course, cones, memos };
  const options = { renderPreview: preview, includeMemos: true };
  const first = await buildCourseArchive(input, options);
  t.mock.timers.tick(5000);
  const second = await buildCourseArchive(input, options);
  assert.equal(Buffer.compare(first.bytes, second.bytes), 0, "identical inputs must produce byte-identical archives");
  const { json, zip } = await unpack(first);
  assert.deepEqual(json.memos, memos);
  assert.ok(zip.file("README.txt"));
});

test("guided public exports preserve repeat visits and exclude memos in the enriched record", async () => {
  const { cones, markers, steps } = measuredSkidpadFixture();
  const archive = await buildCourseArchive({ course, cones, route: { markers, steps }, memos }, {
    renderPreview: () => { throw new Error("guided tracks should use their pavement minimap"); },
  });
  const { zip, json, inner } = await unpack(archive);
  assert.equal(Object.hasOwn(json, "memos"), false);
  assert.equal(json.route_steps.length, steps.length);
  assert.deepEqual(json.route_steps, steps.map((id) => markers.findIndex((marker) => marker.id === id)));
  assert.equal(Buffer.compare(await zip.file("Race-course.png").async("uint8array"), await inner.file("content/tracks/Race-course/map.png").async("uint8array")), 0);
});

test("an invalid course rejects export before producing an incomplete archive", async () => {
  await assert.rejects(buildCourseArchive({ course, cones: [] }, { renderPreview: preview }), /중심선|콘|cone/i);
});
