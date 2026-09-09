import assert from "node:assert/strict";
import test from "node:test";

import {
  createLookupLoader,
  isLookupEntryAvailable,
  isTerminalLookupError,
} from "../../competition/modules/queue/web/src/lookup-state.js";

function httpError(status, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("terminal lookup errors distinguish invalid entries from transient failures", () => {
  for (const status of [400, 404, 410]) {
    assert.equal(isTerminalLookupError({ status }), true);
  }
  for (const status of [0, 429, 500, 503, undefined]) {
    assert.equal(isTerminalLookupError({ status }), false);
  }
});

test("lookup entries must still exist and remain active", () => {
  const entries = {
    1: { active: true },
    2: { active: false },
    3: {},
  };

  assert.equal(isLookupEntryAvailable(entries, "1"), true);
  assert.equal(isLookupEntryAvailable(entries, "2"), false);
  assert.equal(isLookupEntryAvailable(entries, "3"), true);
  assert.equal(isLookupEntryAvailable(entries, "4"), false);
});

test("lookup loader preserves each independent service result", async () => {
  const registration = { position: 3, waitingTotal: 8 };
  const registrationOnly = createLookupLoader({
    fetchQueue: async () => { throw httpError(503); },
    fetchRegistration: async () => registration,
  });

  const partial = await registrationOnly.load("30");
  assert.equal(partial.terminalError, null);
  assert.equal(partial.queue.apply, false);
  assert.equal(partial.queue.error.status, 503);
  assert.deepEqual(partial.registration, { apply: true, value: registration, error: null });

  const queueOnly = createLookupLoader({
    fetchQueue: async () => ({ queues: [{ type: "tilting", rank: 2 }] }),
    fetchRegistration: async () => { throw httpError(503); },
  });
  const inverse = await queueOnly.load("31");
  assert.deepEqual(inverse.queue.value, [{ type: "tilting", rank: 2 }]);
  assert.equal(inverse.queue.apply, true);
  assert.equal(inverse.registration.apply, false);
  assert.equal(inverse.registration.error.status, 503);

  const noRegistration = createLookupLoader({
    fetchQueue: async () => ({ queues: [] }),
    fetchRegistration: async () => { throw httpError(404); },
  });
  assert.deepEqual((await noRegistration.load("32")).registration, {
    apply: true,
    value: null,
    error: null,
  });
});

test("terminal Queue failures clear the whole lookup despite a successful Registration response", async () => {
  const terminal = httpError(400, "존재하지 않는 엔트리 번호입니다.");
  const loader = createLookupLoader({
    fetchQueue: async () => { throw terminal; },
    fetchRegistration: async () => ({ position: 1 }),
  });

  const result = await loader.load("999");
  assert.equal(result.terminalError, terminal);
});

test("lookup loader discards responses superseded by a newer query or input change", async () => {
  const queueRequests = new Map();
  const registrationRequests = new Map();
  const loader = createLookupLoader({
    fetchQueue(num) {
      const request = deferred();
      queueRequests.set(num, request);
      return request.promise;
    },
    fetchRegistration(num) {
      const request = deferred();
      registrationRequests.set(num, request);
      return request.promise;
    },
  });

  const first = loader.load("30");
  const second = loader.load("31");
  queueRequests.get("31").resolve({ queues: [{ type: "brake", rank: 1 }] });
  registrationRequests.get("31").resolve({ position: 2 });
  assert.equal((await second).num, "31");

  queueRequests.get("30").resolve({ queues: [{ type: "tilting", rank: 9 }] });
  registrationRequests.get("30").resolve({ position: 9 });
  assert.equal(await first, null);

  const invalidated = loader.load("32");
  loader.invalidate();
  queueRequests.get("32").resolve({ queues: [] });
  registrationRequests.get("32").resolve({ position: 4 });
  assert.equal(await invalidated, null);
});
