import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCourseApp } from "../../course/index.mjs";
import { tmpDbPath, makeAuthCookie, createClient, startServer, stopServer, cleanup, setupTestEnv, TRUST_JWT } from "../helpers/test-utils.mjs";

setupTestEnv();
const manager = makeAuthCookie({ email: "course-manager@test.com", role: "official", permissions: ["course.manage"] });
const operator = makeAuthCookie({ email: "course-operator@test.com", role: "official", permissions: ["course.operate"] });
const student = makeAuthCookie({ email: "student@test.com", role: "student" });

async function fixture(t) {
  const dbPath = tmpDbPath();
  const staticRoot = mkdtempSync(join(tmpdir(), "public-course-web-"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Course</title>");
  writeFileSync(join(staticRoot, "public.html"), "<!doctype html><title>Public course</title>");
  writeFileSync(join(staticRoot, "env-config.js"), "window.__TEST_SERVER__ = true;");
  const app = createCourseApp({ dbPath, staticRoot, validateUser: TRUST_JWT });
  const { server, baseUrl } = await startServer(app.app);
  t.after(async () => { app.close(); await stopServer(server); app.db.close(); cleanup(dbPath); rmSync(staticRoot, { recursive: true }); });
  const client = createClient(baseUrl);
  const created = await client.post("/api/courses", { cookie: manager, body: { name: "Race course" } });
  assert.equal(created.status, 201);
  const course = await created.json();
  const publish = (value, cookie = manager) => client.patch(`/api/courses/${course.id}/publication`, { cookie, body: { is_public: value } });
  return { ...app, client, baseUrl, server, course, publish };
}

test("public UI and settings load anonymously while operational routes remain protected", async (t) => {
  const { client, baseUrl } = await fixture(t);
  for (const path of ["/public", "/public/", "/env-config.js"]) {
    const response = await fetch(baseUrl + path, { redirect: "manual" });
    assert.equal(response.status, 200, path);
  }
  const privatePage = await fetch(baseUrl + "/", { redirect: "manual" });
  assert.equal(privatePage.status, 302);
  for (const path of ["/api/courses", "/api/events", "/api/rover/status", "/api/courses/1/memos", "/api/courses/1/export"]) {
    assert.equal((await client.get(path)).status, 401, path);
  }
  assert.equal((await client.post("/api/public/courses", { body: { name: "unauthorized" } })).status, 401);
});

test("courses are private by default and only course.manage may change publication", async (t) => {
  const { client, course, publish, db } = await fixture(t);
  assert.equal(course.is_public, 0);
  const list = await client.get("/api/public/courses");
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual(await list.json(), []);
  for (const cookie of [null, student, operator]) {
    assert.equal((await publish(true, cookie)).status, cookie ? 403 : 401);
  }
  assert.equal((await client.patch(`/api/courses/${course.id}`, {
    cookie: operator, body: { name: course.name, is_public: true },
  })).status, 200);
  for (const value of [1, "true", null]) assert.equal((await publish(value)).status, 400);
  assert.equal(db.prepare("SELECT is_public FROM course WHERE id = ?").get(course.id).is_public, 0);
  assert.equal((await publish(true)).status, 200);
  const audit = db.prepare("SELECT detail FROM logs WHERE action = 'course.publication' AND level = 'info'").get();
  assert.deepEqual(JSON.parse(audit.detail), { before: { is_public: false }, after: { is_public: true } });
  const imported = await client.post("/api/courses/import", { cookie: manager, body: { name: "Imported", cones: [], is_public: true } });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).is_public, 0);
});

test("public data carries live course geometry and never memos or operational fields", async (t) => {
  const { client, course, publish } = await fixture(t);
  const cone = await (await client.post(`/api/courses/${course.id}/cones`, { cookie: manager, body: { lat: 35.292, lng: 126.574, alt: 20, side: "left" } })).json();
  await client.post(`/api/courses/${course.id}/memos`, { cookie: manager, body: { lat: 35.292, lng: 126.574, width: 3, height: 2, content: "private marshal note" } });
  const marker = await (await client.post(`/api/courses/${course.id}/route/markers`, { cookie: manager, body: { lat: 35.292, lng: 126.574, label: "Start" } })).json();
  await client.put(`/api/courses/${course.id}/route/steps`, { cookie: manager, body: { steps: [marker.id, marker.id] } });
  await publish(true);
  const response = await client.get(`/api/public/courses/${course.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    course: { id: course.id, name: course.name, reverse: 0, start_cone_id: null },
    cones: [{ id: cone.id, lat: 35.292, lng: 126.574, alt: 20, side: "left" }],
    route: { markers: [{ id: marker.id, lat: 35.292, lng: 126.574, label: "Start" }], steps: [marker.id, marker.id] },
  });
  await client.patch(`/api/courses/${course.id}`, { cookie: manager, body: { name: "Updated" } });
  assert.equal((await (await client.get(`/api/public/courses/${course.id}`)).json()).course.name, "Updated");
  assert.deepEqual(await (await client.get("/api/public/courses", { cookie: student })).json(), [{ id: course.id, name: "Updated", cone_count: 1 }]);
  // Internal exports still support the original annotation round trip.
  const privateExport = await (await client.get(`/api/courses/${course.id}/export`, { cookie: manager })).json();
  assert.equal(privateExport.memos[0].content, "private marshal note");
});

test("revocation and deletion hide details even from an authenticated manager on public URLs", async (t) => {
  const { client, course, publish } = await fixture(t);
  const unavailable = await client.get(`/api/public/courses/${course.id}`);
  assert.equal(unavailable.status, 404);
  const missing = await client.get("/api/public/courses/999999");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), await unavailable.text());
  await publish(true);
  await publish(false);
  assert.equal((await client.get(`/api/public/courses/${course.id}`, { cookie: manager })).status, 404);
  await publish(true);
  await client.delete(`/api/courses/${course.id}`, { cookie: manager });
  assert.equal((await client.get(`/api/public/courses/${course.id}`)).status, 404);
  assert.deepEqual(await (await client.get("/api/public/courses")).json(), []);
});

test("publication persistence failures are audited without changing the stored state", async (t) => {
  const { db, publish, course } = await fixture(t);
  db.exec("CREATE TRIGGER reject_publication BEFORE UPDATE OF is_public ON course BEGIN SELECT RAISE(ABORT, 'publication storage failure'); END");
  assert.equal((await publish(true)).status, 500);
  assert.equal(db.prepare("SELECT is_public FROM course WHERE id = ?").get(course.id).is_public, 0);
  const warning = db.prepare("SELECT detail FROM logs WHERE action = 'course.publication' AND level = 'warn'").get();
  assert.match(JSON.parse(warning.detail).error, /publication storage failure/);
});

test("the public viewer has no event stream endpoint", async (t) => {
  const { client } = await fixture(t);
  assert.equal((await client.get("/api/public/events")).status, 401);
  assert.equal((await client.get("/api/public/events", { cookie: manager })).status, 404);
});

test("existing course databases gain a private default without changing geometry or annotations", async () => {
  const dbPath = tmpDbPath();
  let created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
  try {
    created.db.prepare("INSERT INTO course (name) VALUES (?)").run("Existing");
    created.db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (1, 35, 126, 'left')").run();
    created.db.exec("ALTER TABLE course DROP COLUMN is_public");
    created.close(); created.db.close();
    created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    assert.equal(created.db.prepare("SELECT is_public FROM course").get().is_public, 0);
    assert.equal(created.db.prepare("SELECT COUNT(*) AS n FROM cone").get().n, 1);
    assert.throws(() => created.db.prepare("UPDATE course SET is_public = 2").run(), /CHECK/);
  } finally { created.close(); created.db.close(); cleanup(dbPath); }
});
