import assert from "node:assert/strict";
import test from "node:test";

import {
  clearFullscreenLayout,
  isFullscreenSupported,
  KIOSK_FULLSCREEN_CLASS,
  syncFullscreenLayout,
  toggleFullscreen,
} from "../../shared/browser/fullscreen.js";

test("fullscreen support requires both enter and exit operations", () => {
  assert.equal(isFullscreenSupported(null), false);
  assert.equal(isFullscreenSupported({ documentElement: { requestFullscreen() {} } }), false);
  assert.equal(isFullscreenSupported({
    documentElement: { requestFullscreen() {} },
    exitFullscreen() {},
  }), true);
});

test("fullscreen toggle enters and exits according to document state", async () => {
  const calls = [];
  const documentLike = {
    fullscreenElement: null,
    documentElement: {
      async requestFullscreen() { calls.push("enter"); },
    },
    async exitFullscreen() { calls.push("exit"); },
  };

  await toggleFullscreen(documentLike);
  documentLike.fullscreenElement = documentLike.documentElement;
  await toggleFullscreen(documentLike);

  assert.deepEqual(calls, ["enter", "exit"]);
});

test("fullscreen toggle rejects unsupported documents", async () => {
  await assert.rejects(toggleFullscreen({}), /Fullscreen API is unavailable/);
});

test("fullscreen layout class follows fullscreen state and can be cleaned up", () => {
  const classes = new Set();
  const documentLike = {
    body: {
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        remove(name) { classes.delete(name); },
      },
    },
    fullscreenElement: null,
  };

  assert.equal(syncFullscreenLayout(documentLike), false);
  assert.equal(classes.has(KIOSK_FULLSCREEN_CLASS), false);

  documentLike.fullscreenElement = {};
  assert.equal(syncFullscreenLayout(documentLike), true);
  assert.equal(classes.has(KIOSK_FULLSCREEN_CLASS), true);

  clearFullscreenLayout(documentLike);
  assert.equal(classes.has(KIOSK_FULLSCREEN_CLASS), false);
});
