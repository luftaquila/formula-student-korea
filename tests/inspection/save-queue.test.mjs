import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSaveQueue,
  reconcileSaveQueuesAfterReconnect,
} from "../../inspection/web/src/utils/save-queue.js";

describe("inspection field save queue", () => {
  it("serializes same-field saves and carries the last successful value as expected", async () => {
    const requests = [];
    const resolvers = [];
    const queue = createSaveQueue({
      delay: 0,
      save: (id, request) => {
        requests.push({ id, ...request });
        return new Promise((resolve) => resolvers.push(resolve));
      },
      responseValue: response => response.value,
      currentValue: current => current.value,
    });
    const first = queue.enqueue(1, "PASS", { expected: "", immediate: true });
    queue.enqueue(1, "FAIL", { expected: "PASS", immediate: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].expected, "");
    resolvers.shift()({ value: "PASS" });
    await Promise.resolve();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].expected, "PASS");
    resolvers.shift()({ value: "FAIL" });
    await first;
  });

  it("discards a stale local value and reports the server value", async () => {
    const stale = [];
    const queue = createSaveQueue({
      delay: 0,
      save: async () => {
        const error = Object.assign(new Error("stale"), {
          status: 409,
          data: { code: "INSPECTION_STALE_WRITE", current: { value: "server" } },
        });
        throw error;
      },
      responseValue: response => response.value,
      currentValue: current => current.value,
      onStale: (id, current) => stale.push({ id, current }),
    });
    await queue.enqueue(3, "local", { expected: "old", immediate: true });
    assert.deepEqual(stale, [{ id: 3, current: { value: "server" } }]);
    assert.equal(queue.isDirty(3), false);
  });

  it("drops a queued edit when an SSE update arrives first", () => {
    const stale = [];
    const queue = createSaveQueue({
      delay: 60_000,
      save: async () => ({ value: "local" }),
      responseValue: response => response.value,
      currentValue: current => current.value,
      onStale: (id, current) => stale.push({ id, current }),
    });
    queue.enqueue(4, "local", { expected: "old" });
    queue.rejectForRemote(4, { value: "remote" });
    assert.equal(queue.isDirty(4), false);
    assert.deepEqual(stale, [{ id: 4, current: { value: "remote" } }]);
  });

  it("recognizes a successful mutation until its later SSE echo is consumed", async () => {
    const queue = createSaveQueue({
      delay: 0,
      save: async (id, request) => ({ value: request.value }),
      responseValue: response => response.value,
      currentValue: current => current.value,
      makeMutationId: () => "response-before-sse",
    });

    await queue.enqueue(5, "saved", { expected: "old", immediate: true });
    assert.equal(queue.isOwnMutation(5, "response-before-sse"), true);
    assert.equal(queue.isOwnMutation(5, "response-before-sse"), false);
    assert.equal(queue.isOwnMutation(5, "another-mutation"), false);
  });

  it("discards failed first edits that have no server row after reconnect", async () => {
    const answerStale = [];
    const memoStale = [];
    const failedSave = async () => { throw new Error("offline"); };
    const answerQueue = createSaveQueue({
      delay: 0,
      save: failedSave,
      responseValue: response => response.value,
      currentValue: current => current.value,
      onStale: (id, current) => answerStale.push({ id, current }),
    });
    const memoQueue = createSaveQueue({
      delay: 0,
      save: failedSave,
      responseValue: response => response.memo,
      currentValue: current => current.memo,
      onStale: (id, current) => memoStale.push({ id, current }),
    });
    await answerQueue.enqueue(6, "hidden answer", { expected: "", immediate: true });
    await memoQueue.enqueue(7, "hidden memo", { expected: "", immediate: true });
    assert.deepEqual(answerQueue.dirtyIds(), [6]);
    assert.deepEqual(memoQueue.dirtyIds(), [7]);

    reconcileSaveQueuesAfterReconnect({
      answers: {},
      itemIds: [6, 7],
      answerQueue,
      memoQueue,
    });

    assert.equal(answerQueue.isDirty(6), false);
    assert.equal(memoQueue.isDirty(7), false);
    assert.equal(answerStale[0].current.value, "");
    assert.equal(memoStale[0].current.memo, "");
  });
});
