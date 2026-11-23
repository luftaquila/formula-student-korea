import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// Live cone sync across two browser clients via the course SSE stream
// (/course/api/events). Both clients pin the same seeded course.

test.use({ viewport: { width: 1280, height: 800 } });

test.describe("Course SSE sync", () => {
  let courseId;

  test.afterEach(async ({ browser }) => {
    if (courseId) {
      const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
      await ctx.request.delete(`/course/api/courses/${courseId}`);
      await ctx.close();
    }
    courseId = null;
  });

  test("a cone added in context A appears in context B", async ({ browser }) => {
    const ctxA = await browser.newContext({ storageState: storageStatePath("admin") });
    const ctxB = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Seed a uniquely-named course and pin it active in both clients.
      const name = `e2e-sse-${Date.now()}-${test.info().parallelIndex}`;
      const created = await pageA.request.post("/course/api/courses", { data: { name } });
      expect(created.ok()).toBeTruthy();
      courseId = (await created.json()).id;
      await pageA.request.post(`/course/api/courses/${courseId}/cones`, {
        data: { lat: 37.5, lng: 127.0, side: "left" },
      });

      for (const p of [pageA, pageB]) {
        await p.addInitScript((id) => localStorage.setItem("coursekeeper.console.activeCourseId", String(id)), courseId);
      }

      // Subscribe to the SSE stream BEFORE navigating so we don't miss events.
      const sseA = pageA.waitForResponse((r) => r.url().includes("/course/api/events"));
      const sseB = pageB.waitForResponse((r) => r.url().includes("/course/api/events"));
      await pageA.goto("/course");
      await pageB.goto("/course");
      await waitForPageReady(pageA);
      await waitForPageReady(pageB);
      await sseA;
      await sseB;

      // Both clients show the seeded cone.
      const conesB = pageB.getByTestId("cone-row");
      await expect(conesB).toHaveCount(1, { timeout: 10000 });
      const baselineB = await conesB.count();

      // Context A creates a cone via API → broadcasts cones:add over SSE.
      const add = await pageA.request.post(`/course/api/courses/${courseId}/cones`, {
        data: { lat: 37.5005, lng: 127.0005, side: "right" },
      });
      expect(add.status()).toBe(201);

      // Context B's cone list grows (auto-retrying assertion over the SSE update).
      await expect(conesB).toHaveCount(baselineB + 1, { timeout: 10000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
