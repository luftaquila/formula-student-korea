import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TRUST_JWT,
} from "../helpers/test-utils.mjs";

setupTestEnv();

import { createCourseApp } from "../../course/index.mjs";
import { computeCenterline } from "../../course/lib/centerline.mjs";
import { resolveCourseRoute, ROUTE_MODE } from "../../course/lib/route-mode.mjs";

const SEED_MIGRATION = "course.seed_route_markers_from_direction.v1";
const chiefCookie = makeAuthCookie({ email: "chief@test.com", name: "Chief", role: "chief" });
const fixture = JSON.parse(readFileSync(new URL("./fixtures/endurance.json", import.meta.url), "utf8"));

// Courses created before route markers existed carry their travel direction in
// course.reverse / course.start_cone_id. Removing the direction toggle from the
// UI would strand them, so the service seeds each one with the two markers that
// reproduce that stored direction. Written straight into the database and then
// re-opened, because the migration only runs while the service boots.
function seedLegacyCourse(db, { name, reverse, startConeIndex }) {
  const courseId = db.prepare("INSERT INTO course (name) VALUES (?)").run(name).lastInsertRowid;
  const insertCone = db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (?, ?, ?, ?)");
  const coneIds = fixture.cones.map((cone) => insertCone.run(courseId, cone.lat, cone.lng, cone.side).lastInsertRowid);
  db.prepare("UPDATE course SET reverse = ?, start_cone_id = ? WHERE id = ?")
    .run(reverse ? 1 : 0, startConeIndex == null ? null : coneIds[startConeIndex], courseId);
  return { courseId, startCone: startConeIndex == null ? null : fixture.cones[startConeIndex] };
}

describe("route marker seeding migration", () => {
  let dbPath, server, client, db;
  let reversedCourse, forwardCourse, emptyCourseId;

  before(async () => {
    dbPath = tmpDbPath();
    // First boot creates the schema; the migration is a no-op on an empty file.
    const first = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    reversedCourse = seedLegacyCourse(first.db, { name: "레거시 역방향", reverse: true, startConeIndex: 12 });
    forwardCourse = seedLegacyCourse(first.db, { name: "레거시 정방향", reverse: false, startConeIndex: null });
    // A course with no cones must survive the sweep untouched.
    emptyCourseId = first.db.prepare("INSERT INTO course (name) VALUES (?)").run("콘 없는 코스").lastInsertRowid;
    first.db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(SEED_MIGRATION);
    first.db.close();

    // Second boot runs the migration with the legacy rows in place.
    const result = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    db = result.db;
    const started = await startServer(result.app);
    server = started.server;
    client = createClient(started.baseUrl);
  });

  after(async () => {
    await stopServer(server);
    db.close();
    cleanup(dbPath);
  });

  it("records the migration once", () => {
    const row = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(SEED_MIGRATION);
    assert.ok(row, "the migration must be marked applied");
  });

  it("seeds two markers and a two-step order per legacy course", async () => {
    for (const course of [reversedCourse, forwardCourse]) {
      const res = await client.get(`/api/courses/${course.courseId}/route`, { cookie: chiefCookie });
      assert.equal(res.status, 200);
      const route = await res.json();
      assert.equal(route.markers.length, 2, "one start marker plus one direction marker");
      assert.deepEqual(route.steps, route.markers.map((marker) => marker.id));
    }
  });

  it("leaves a course with no cones alone", async () => {
    const res = await client.get(`/api/courses/${emptyCourseId}/route`, { cookie: chiefCookie });
    assert.equal(res.status, 200);
    const route = await res.json();
    assert.deepEqual(route, { markers: [], steps: [] });
  });

  // The whole point of seeding: the geometry these markers resolve to must be
  // the geometry the course already had.
  for (const [label, get] of [["reverse=true", () => reversedCourse], ["reverse=false", () => forwardCourse]]) {
    it(`resolves ${label} to the same centerline the stored row produced`, async () => {
      const course = get();
      const res = await client.get(`/api/courses/${course.courseId}/route`, { cookie: chiefCookie });
      const route = await res.json();

      const stored = {
        step: 1,
        metric: true,
        ...(course.startCone ? { start: { lat: course.startCone.lat, lng: course.startCone.lng } } : {}),
        ...(label === "reverse=true" ? { reverse: true } : {}),
      };
      const expected = computeCenterline(fixture.cones, stored);
      const resolved = resolveCourseRoute(fixture.cones, route.markers, route.steps, { step: 1, metric: true });

      assert.equal(resolved.mode, ROUTE_MODE.ORIENTED, "a seeded loop must stay on the legacy engine");
      assert.equal(resolved.reverse, label === "reverse=true");
      assert.deepEqual(resolved.centerline, expected);
    });
  }

  it("does not re-seed a course that already has an order", async () => {
    const before = await (await client.get(`/api/courses/${forwardCourse.courseId}/route`, { cookie: chiefCookie })).json();
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(SEED_MIGRATION);

    const again = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    again.db.close();

    const after = await (await client.get(`/api/courses/${forwardCourse.courseId}/route`, { cookie: chiefCookie })).json();
    assert.deepEqual(after, before, "an existing order must not gain extra markers");
  });
});
