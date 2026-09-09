import assert from "node:assert/strict";
import test from "node:test";

import { createCoalescedRefresh } from "../../competition/modules/queue/web/src/coalesced-refresh.js";

test("coalesced refresh merges simultaneous requests and runs one trailing refresh", async () => {
  const scheduled = [];
  const releases = [];
  let refreshes = 0;
  const refresher = createCoalescedRefresh({
    schedule: (callback) => scheduled.push(callback),
    refresh: () => {
      refreshes += 1;
      return new Promise((resolve) => releases.push(resolve));
    },
  });

  const first = refresher.request();
  const duplicate = refresher.request();
  assert.equal(scheduled.length, 1);
  assert.equal(refreshes, 0);

  scheduled.shift()();
  await Promise.resolve();
  assert.equal(refreshes, 1);

  refresher.request();
  refresher.request();
  assert.equal(scheduled.length, 0);

  releases.shift()();
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await Promise.resolve();
  assert.equal(refreshes, 2);
  releases.shift()();
});

test("stopping a coalesced refresh prevents scheduled work from running", async () => {
  const scheduled = [];
  let refreshes = 0;
  const refresher = createCoalescedRefresh({
    schedule: (callback) => scheduled.push(callback),
    refresh: () => { refreshes += 1; },
  });

  const pending = refresher.request();
  refresher.stop();
  scheduled.shift()();

  assert.equal(await pending, false);
  assert.equal(await refresher.request(), false);
  assert.equal(refreshes, 0);
});
