import test from "node:test";
import assert from "node:assert/strict";
import { createPublicCourseData } from "../../course/web/src/lib/public-course-data.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const row = (id, name = "Course") => ({ id, name, cone_count: 0 });
const detail = (id, name = "Course") => ({ course: { id, name }, cones: [], route: { markers: [], steps: [] } });
const initialState = () => ({ courses: [], details: {}, selectedId: null, overlays: {}, loading: true, error: "" });

test("refresh selects an available course and retains only explicit overlays for available courses", async () => {
  const state = initialState();
  state.overlays = { 2: true, 3: true };
  const data = createPublicCourseData(state, { request: async (path) => path.endsWith("courses") ? [row(1), row(2)] : detail(Number(path.split("/").at(-1))) });
  await data.refresh();
  assert.equal(state.selectedId, 1);
  assert.deepEqual(state.overlays, { 2: true });
  state.selectedId = 2;
  await data.refresh();
  assert.equal(state.selectedId, 2);
  assert.equal(state.loading, false);
});

test("a late detail response cannot restore a revoked course after a newer refresh", async () => {
  const state = initialState();
  const started = deferred(), old = deferred();
  let listCalls = 0;
  const data = createPublicCourseData(state, { request: async (path) => {
    if (path.endsWith("courses")) return ++listCalls === 1 ? [row(1)] : [row(2)];
    if (path.endsWith("/1")) { started.resolve(); return old.promise; }
    return detail(2);
  } });
  const first = data.refresh();
  await started.promise;
  await data.refresh();
  old.resolve(detail(1));
  await first;
  assert.deepEqual(state.courses.map((course) => course.id), [2]);
  assert.deepEqual(Object.keys(state.details), ["2"]);
  assert.equal(state.selectedId, 2);
});

test("revocation between list and detail removes that course and selects another", async () => {
  const state = initialState();
  state.selectedId = 1;
  const data = createPublicCourseData(state, { request: async (path) => {
    if (path.endsWith("courses")) return [row(1), row(2)];
    if (path.endsWith("/1")) throw Object.assign(new Error("unavailable"), { status: 404 });
    return detail(2);
  } });
  await data.refresh();
  assert.deepEqual(state.courses.map((course) => course.id), [2]);
  assert.equal(state.selectedId, 2);
});

test("request failures clear displayed geometry and prevent cached downloads; manual refresh recovers", async () => {
  const state = initialState();
  let failed = false;
  const data = createPublicCourseData(state, { request: async (path) => {
    if (failed) throw new Error("connection failed");
    return path.endsWith("courses") ? [row(1)] : detail(1);
  } });
  await data.refresh();
  failed = true;
  await data.refresh();
  assert.equal(state.error, "connection failed");
  assert.deepEqual(state.courses, []);
  failed = false;
  await data.refresh();
  assert.ok(state.details[1]);
  assert.equal(state.error, "");
});

test("download fetches fresh public data instead of using the displayed cache", async () => {
  const state = initialState();
  let name = "Old";
  const data = createPublicCourseData(state, { request: async (path) => path.endsWith("courses") ? [row(1)] : detail(1, name) });
  await data.refresh();
  name = "New";
  const result = await data.exportCourse(1, async (input) => input.course.name);
  assert.equal(result, "New");
  assert.equal(state.details[1].course.name, "Old");
});

test("an archive still being generated is discarded when the view is disposed", async () => {
  const state = initialState();
  const data = createPublicCourseData(state, { request: async (path) => path.endsWith("courses") ? [row(1)] : detail(1) });
  await data.refresh();
  const started = deferred(), archive = deferred();
  const download = data.exportCourse(1, () => { started.resolve(); return archive.promise; });
  const rejected = assert.rejects(download, /코스가 변경/);
  await started.promise;
  data.dispose();
  archive.resolve("stale archive");
  await rejected;
});

test("disposal prevents outstanding reads from committing to a departed view", async () => {
  const state = initialState();
  const pending = deferred();
  const data = createPublicCourseData(state, { request: () => pending.promise });
  const refresh = data.refresh();
  data.dispose();
  pending.resolve([row(1)]);
  await refresh;
  assert.deepEqual(state.courses, []);
  assert.deepEqual(state.details, {});
});

test("refreshing another course does not cancel a still-current download", async () => {
  const state = initialState();
  const data = createPublicCourseData(state, { request: async (path) => path.endsWith("courses") ? [row(1)] : detail(1) });
  await data.refresh();
  const started = deferred(), archive = deferred();
  const download = data.exportCourse(1, () => { started.resolve(); return archive.promise; });
  await started.promise;
  await data.refresh();
  archive.resolve("current archive");
  assert.equal(await download, "current archive");
});

test("publication is checked again before delivering a generated archive", async () => {
  const state = initialState();
  let published = true;
  const data = createPublicCourseData(state, { request: async (path) => {
    if (path.endsWith("courses")) return published ? [row(1)] : [];
    if (!published) throw Object.assign(new Error("unavailable"), { status: 404 });
    return detail(1);
  } });
  await data.refresh();
  const started = deferred(), archive = deferred();
  const download = data.exportCourse(1, () => { started.resolve(); return archive.promise; });
  const rejected = assert.rejects(download, { status: 404 });
  await started.promise;
  published = false;
  archive.resolve("revoked archive");
  await rejected;
  assert.deepEqual(state.details[1], detail(1));
  assert.deepEqual(state.courses, [row(1)]);
  data.dispose();
});
