import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Course service RBAC backstop. The frontend hides tabs/buttons by permission,
// while these gates (course/index.mjs authRoleFn) remain the enforcing layer:
//   Course checkbox → course.manage, which includes course.operate
//   rover.operate  → rover and missions
//   admin          → logs
//   internal-strict (deny even an admin browser) → /api/rover/stream, /camera,
//     /camera/control, /obstacle, /calibration-progress
//
// All assertions go through APIRequestContext (ctx.request / page.request) so no
// SSE stream is held open — a denied internal-strict GET returns its 403 (or a
// short 200 header for /stream) immediately and is closed by .close().

test.describe("Course RBAC gates", () => {
  test("course access can create a course and a cone (201)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("technicalOperator") });
    try {
      const name = `e2e-rbac-course-editor-${Date.now()}-${test.info().parallelIndex}`;
      const created = await ctx.request.post("/course/api/courses", { data: { name } });
      expect(created.status()).toBe(201);
      const course = await created.json();
      expect(course.name).toBe(name);

      const cone = await ctx.request.post(`/course/api/courses/${course.id}/cones`, {
        data: { lat: 37.5, lng: 127.0, side: "left" },
      });
      expect(cone.status()).toBe(201);

      const deleted = await ctx.request.delete(`/course/api/courses/${course.id}`);
      expect(deleted.status()).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test("course access includes management but excludes unrelated permissions", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("technicalOperator") });
    try {
      // Seed a real course and cone to exercise all management operations.
      const name = `e2e-rbac-course-manager-${Date.now()}-${test.info().parallelIndex}`;
      const admin = await browser.newContext({ storageState: storageStatePath("admin") });
      const created = await admin.request.post("/course/api/courses", { data: { name } });
      expect(created.status()).toBe(201);
      const courseId = (await created.json()).id;
      await admin.request.post(`/course/api/courses/${courseId}/cones`, {
        data: { lat: 37.5, lng: 127.0, side: "left" },
      });

      // rover control + mission history + logs require independent grants.
      const roverExec = await ctx.request.post("/course/api/rover/execute", { data: { waypoints: [] } });
      expect(roverExec.status()).toBe(403);
      const missions = await ctx.request.get("/course/api/missions");
      expect(missions.status()).toBe(403);
      const logs = await ctx.request.get("/course/api/logs");
      expect(logs.status()).toBe(403);

      // The single Course checkbox grants snapshot and destructive management too.
      const snapCreate = await ctx.request.post(`/course/api/courses/${courseId}/snapshots`, { data: {} });
      expect(snapCreate.status()).toBe(201);
      const snapshotId = (await snapCreate.json()).id;
      const snapRestore = await ctx.request.post(`/course/api/courses/${courseId}/snapshots/${snapshotId}/restore`);
      expect(snapRestore.status()).toBe(200);
      const snapDelete = await ctx.request.delete(`/course/api/courses/${courseId}/snapshots/${snapshotId}`);
      expect(snapDelete.status()).toBe(204);

      const courseDelete = await ctx.request.delete(`/course/api/courses/${courseId}`);
      expect(courseDelete.status()).toBe(200);

      await admin.close();
    } finally {
      await ctx.close();
    }
  });

  test("officials without course.operate and students are denied course create", async ({ browser }) => {
    for (const profile of ["operationsManager", "operationsOperator", "student"]) {
      const ctx = await browser.newContext({ storageState: storageStatePath(profile) });
      try {
        const res = await ctx.request.post("/course/api/courses", {
          data: { name: `e2e-rbac-${profile}-${Date.now()}-${test.info().parallelIndex}` },
        });
        expect(res.status(), `${profile} course create`).toBe(403);
      } finally {
        await ctx.close();
      }
    }
  });

  test("unauthenticated page redirects to / and unauth API → 401", async ({ browser }) => {
    // No storageState → no auth cookie.
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto("/course");
      // Non-API routes redirect to the landing root on 401.
      await expect(page).toHaveURL(/\/$/, { timeout: 10000 });

      const api = await ctx.request.get("/course/api/courses");
      expect(api.status()).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  test("internal-strict rover endpoints deny an admin browser (403)", async ({ browser }) => {
    // Even a logged-in admin (no X-Internal-Service header, which Caddy would
    // strip anyway off these paths) must be denied — these are rover/perception
    // -only. ctx.request buffers, so the 403 returns immediately; for /stream the
    // gate denies BEFORE the handler writes the event-stream head, so this never
    // hangs on a held-open SSE.
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      for (const path of [
        "/course/api/rover/stream",
        "/course/api/rover/camera",
        "/course/api/rover/camera/control",
        "/course/api/rover/obstacle",
        "/course/api/rover/calibration-progress",
      ]) {
        const res = await ctx.request.get(path, { timeout: 8000 });
        expect(res.status(), `admin GET ${path}`).toBe(403);
      }
    } finally {
      await ctx.close();
    }
  });
});
