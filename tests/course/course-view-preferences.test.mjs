import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMapBearing, renderMapBearing, readPublicCoursePreferences, savePublicCoursePreference } from "../../course/web/src/lib/course-view-preferences.mjs";

const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("public course preferences survive re-entry independently of operator settings", () => {
  const storage = memoryStorage();
  storage.setItem("mapview.mapBearing", "90");
  assert.deepEqual(readPublicCoursePreferences(storage), { selectedId: null, overlays: {}, showCenterline: true, mapBearing: 0 });
  const saved = { selectedId: 42, overlays: { 7: true }, showCenterline: false, mapBearing: 270 };
  for (const [key, value] of Object.entries(saved)) savePublicCoursePreference(storage, key, value);
  assert.deepEqual(readPublicCoursePreferences(storage), saved);
  assert.equal(storage.getItem("mapview.mapBearing"), "90");
});

test("corrupt or unavailable preferences use safe defaults", () => {
  const storage = memoryStorage();
  for (const key of ["selectedId", "mapBearing", "overlays"]) storage.setItem(`publicCourse.${key}`, "invalid");
  const defaults = { selectedId: null, overlays: {}, showCenterline: true, mapBearing: 0 };
  assert.deepEqual(readPublicCoursePreferences(storage), defaults);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readPublicCoursePreferences(blocked), defaults);
  assert.doesNotThrow(() => savePublicCoursePreference(blocked, "selectedId", 1));
  storage.setItem("publicCourse.overlays", '{"1":true,"2":"true","3":false}');
  assert.deepEqual(readPublicCoursePreferences(storage).overlays, { 1: true });
});

test("four counterclockwise quarter-turns return north and half-turn rendering avoids the tile defect", () => {
  let bearing = 0;
  const turns = [];
  for (let i = 0; i < 4; i++) { bearing = normalizeMapBearing(bearing - 90); turns.push(bearing); }
  assert.deepEqual(turns, [270, 180, 90, 0]);
  assert.equal(renderMapBearing(180), 179.9);
  assert.equal(renderMapBearing(270), 270);
});
