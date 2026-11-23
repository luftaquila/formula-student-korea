import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Course service RBAC backstop. The frontend hides tabs/buttons by permission,
// while these gates (course/index.mjs authRoleFn) remain the enforcing layer:
//   Course checkbox → course.manage, which includes course.operate
//   rover.operate  → rover/GPS unit addresses and mission presets
//   admin          → logs
//
// All assertions go through APIRequestContext (ctx.request / page.request).

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

      // Device addresses and logs require independent grants.
      const devices = await ctx.request.get("/course/api/devices");
      expect(devices.status()).toBe(403);
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
});
