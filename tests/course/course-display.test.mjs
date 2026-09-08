import test from "node:test";
import assert from "node:assert/strict";
import { courseDisplayState } from "../../course/web/src/lib/course-display.mjs";

test("selection always displays the course, even with an explicit hidden preference", () => {
  assert.equal(courseDisplayState(1, 1, { 1: false }), "selected");
  assert.equal(courseDisplayState(1, 1), "selected");
});

test("unselected courses appear only as explicitly enabled overlays", () => {
  assert.equal(courseDisplayState(2, 1), "hidden");
  assert.equal(courseDisplayState(2, 1, { 2: false }), "hidden");
  assert.equal(courseDisplayState(2, 1, { 2: true }), "overlay");
});

test("switching selection preserves only explicitly enabled overlays", () => {
  const overlays = { 2: true };
  assert.equal(courseDisplayState(1, 2, overlays), "hidden");
  assert.equal(courseDisplayState(2, 2, overlays), "selected");
  assert.equal(courseDisplayState(2, 3, overlays), "overlay");
  assert.equal(courseDisplayState(3, 3, overlays), "selected");
  assert.deepEqual(overlays, { 2: true });
});
