import test from "node:test";
import assert from "node:assert/strict";
import { createPublicCourseViewport } from "../../course/web/src/lib/public-course-viewport.mjs";

function fixture(t) {
  let resize;
  let disconnected = false;
  const container = { width: 390, height: 700 };
  const previous = globalThis.ResizeObserver;
  t.after(() => { globalThis.ResizeObserver = previous; });
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(target) { assert.equal(target, container); }
    disconnect() { disconnected = true; }
  };
  let cachedHeight = container.height;
  const frames = [];
  const map = {
    getContainer: () => container,
    invalidateSize() { cachedHeight = container.height; },
    fitBounds(points) { frames.push({ points, centerY: cachedHeight / 2 }); },
  };
  let selection = { id: 1, cones: [{ lat: 35, lng: 126 }, { lat: 36, lng: 127 }] };
  const viewport = createPublicCourseViewport(map, () => selection);
  return { viewport, frames, container, resize: () => resize?.(), disconnected: () => disconnected, select: (value) => { selection = value; } };
}

test("course framing follows the visible map when the mobile list reduces its height", (t) => {
  const f = fixture(t);
  f.viewport.fit();
  f.container.height = 450;
  f.resize();
  assert.equal(f.frames.at(-1).centerY, f.container.height / 2);
  assert.deepEqual(f.frames.at(-1).points, [[35, 126], [36, 127]]);
  f.viewport.dispose();
  assert.equal(f.disconnected(), true);
});

test("selecting a course refreshes map dimensions without resetting user framing on redraw", (t) => {
  const f = fixture(t);
  f.viewport.fit();
  f.container.height = 500;
  f.select({ id: 2, cones: [{ lat: 34, lng: 125 }] });
  f.viewport.fit();
  assert.equal(f.frames.at(-1).centerY, 250);
  const count = f.frames.length;
  f.viewport.fit();
  assert.equal(f.frames.length, count);
  f.select({ id: 3, cones: [] });
  f.viewport.fit();
  assert.equal(f.frames.length, count);
  f.viewport.dispose();
});
