import assert from "node:assert/strict";
import test from "node:test";

import { createLookupRefreshScheduler } from "../../queue/web/src/lookup-refresh.js";

function schedulerFixture() {
  let clock = 1_000;
  let nextTimer = 1;
  let refreshes = 0;
  const timers = new Map();
  const canceled = [];
  const scheduler = createLookupRefreshScheduler({
    intervalMs: 10_000,
    refresh: () => { refreshes += 1; },
    now: () => clock,
    schedule(callback, delay) {
      const id = nextTimer++;
      timers.set(id, {
        callback: () => {
          timers.delete(id);
          callback();
        },
        delay,
      });
      return id;
    },
    cancel(id) {
      canceled.push(id);
      timers.delete(id);
    },
  });
  return {
    scheduler,
    timers,
    canceled,
    refreshes: () => refreshes,
    setClock(value) { clock = value; },
  };
}

test("lookup refresh throttling coalesces events and runs one deferred refresh", () => {
  const f = schedulerFixture();
  f.scheduler.markRefreshed();
  f.setClock(2_000);

  assert.equal(f.scheduler.request(), false);
  assert.equal(f.scheduler.request(), false);
  assert.equal(f.timers.size, 1);
  const [{ callback, delay }] = f.timers.values();
  assert.equal(delay, 9_000);
  assert.equal(f.refreshes(), 0);

  f.setClock(11_000);
  callback();
  assert.equal(f.refreshes(), 1);
  assert.equal(f.timers.size, 0);
});

test("forced and manual refreshes cancel a stale deferred callback", () => {
  const f = schedulerFixture();
  f.scheduler.markRefreshed();
  f.setClock(2_000);
  f.scheduler.request();
  const [pendingId] = f.timers.keys();

  assert.equal(f.scheduler.request({ force: true }), true);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.canceled, [pendingId]);
  assert.equal(f.timers.size, 0);

  f.setClock(3_000);
  f.scheduler.request();
  f.scheduler.markRefreshed();
  assert.equal(f.timers.size, 0);
});

test("stopping a lookup scheduler prevents an unmounted view from refreshing", () => {
  const f = schedulerFixture();
  f.scheduler.markRefreshed();
  f.setClock(2_000);
  f.scheduler.request();
  f.scheduler.stop();

  assert.equal(f.timers.size, 0);
  assert.equal(f.scheduler.request({ force: true }), false);
  assert.equal(f.refreshes(), 0);
});
