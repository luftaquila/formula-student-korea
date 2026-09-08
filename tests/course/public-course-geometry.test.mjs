import test from "node:test";
import assert from "node:assert/strict";
import { createPublicCourseGeometry } from "../../course/web/src/lib/public-course-geometry.mjs";

const detail = { course: {}, cones: [], route: { markers: [], steps: [] } };
function fixture() {
  const workers = [], results = [];
  const calculator = createPublicCourseGeometry((...result) => results.push(result), {
    createWorker() {
      const worker = { messages: [], stopped: false, postMessage(value) { this.messages.push(value); }, terminate() { this.stopped = true; } };
      workers.push(worker);
      return worker;
    },
  });
  return { workers, results, calculator };
}

test("route calculation returns control to the UI before publishing geometry", () => {
  const f = fixture();
  f.calculator.replace({ 1: detail });
  assert.deepEqual(f.results, []);
  assert.deepEqual(f.workers[0].messages, [{ 1: detail }]);
  f.workers[0].onmessage({ data: { id: "1", geometry: { line: null } } });
  assert.deepEqual(f.results, [["1", { line: null }]]);
  f.calculator.dispose();
});

test("refresh and disposal stop old calculations and ignore late results", () => {
  const f = fixture();
  f.calculator.replace({ 1: detail });
  const first = f.workers[0];
  f.calculator.replace({ 2: detail });
  assert.equal(first.stopped, true);
  first.onmessage({ data: { id: "1", geometry: {} } });
  assert.deepEqual(f.results, []);
  const second = f.workers[1];
  f.calculator.dispose();
  assert.equal(second.stopped, true);
  second.onmessage({ data: { id: "2", geometry: {} } });
  f.calculator.replace({ 3: detail });
  assert.deepEqual(f.results, []);
  assert.equal(f.workers.length, 2);
});

test("worker failures leave the map usable without synchronous route calculation", () => {
  const f = fixture();
  f.calculator.replace({ 1: detail });
  f.workers[0].onerror({ preventDefault() {} });
  assert.equal(f.workers[0].stopped, true);
  assert.deepEqual(f.results, []);
  f.calculator.dispose();
});

test("the actual worker preserves route geometry and frees the caller before completion", async (t) => {
  const { Worker } = await import("node:worker_threads");
  const { readFileSync } = await import("node:fs");
  const { publicCourseGeometry } = await import("../../course/web/src/lib/public-course-geometry.worker.mjs");
  const { cones } = JSON.parse(readFileSync(new URL("./fixtures/endurance.json", import.meta.url)));
  const input = { course: { reverse: true }, cones, route: { markers: [], steps: [] } };
  const before = performance.now();
  const expected = publicCourseGeometry(input);
  const synchronousMs = performance.now() - before;
  assert.ok(expected.line);

  let publish;
  const result = new Promise((resolve) => { publish = resolve; });
  const calculator = createPublicCourseGeometry((id, geometry) => publish({ id, geometry }), {
    createWorker() {
      const worker = new Worker(new URL("./fixtures/public-course-worker.mjs", import.meta.url));
      const adapter = { postMessage: (data) => worker.postMessage(data), terminate: () => worker.terminate() };
      worker.on("message", (data) => adapter.onmessage({ data }));
      worker.on("error", (error) => publish({ error }));
      return adapter;
    },
  });
  t.after(() => calculator.dispose());
  const start = performance.now();
  calculator.replace({ 1: input });
  const dispatchMs = performance.now() - start;
  let returnedToCaller = false;
  queueMicrotask(() => { returnedToCaller = true; });
  const actual = await result;
  const totalMs = performance.now() - start;
  assert.equal(returnedToCaller, true);
  assert.equal(actual.id, "1");
  assert.deepEqual(actual.geometry, expected);
  t.diagnostic(`same endurance input: synchronous caller blocked ${synchronousMs.toFixed(1)}ms; worker dispatch ${dispatchMs.toFixed(1)}ms; worker result ${totalMs.toFixed(1)}ms`);
});
