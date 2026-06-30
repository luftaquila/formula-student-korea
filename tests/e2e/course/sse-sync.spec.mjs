import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { internalHeaders } from "../helpers/auth.mjs";

// Live cone sync across two browser clients via the course SSE stream
// (/course/api/events), plus the one-shot rover-position broadcast driving the
// map marker. Both clients pin the same seeded course. No held-open rover stream
// is used — the rover position is a single buffered POST.

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

  test("a cone added in context A appears in context B; rover position shows a marker", async ({ browser }) => {
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
        await p.addInitScript((id) => localStorage.setItem("mapview.activeCourseId", String(id)), courseId);
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
      await expect(pageB.locator(".cone-item")).toHaveCount(1, { timeout: 10000 });
      const baselineB = await pageB.locator(".cone-item").count();

      // Context A creates a cone via API → broadcasts cones:add over SSE.
      const add = await pageA.request.post(`/course/api/courses/${courseId}/cones`, {
        data: { lat: 37.5005, lng: 127.0005, side: "right" },
      });
      expect(add.status()).toBe(201);

      // Context B's cone list grows (auto-retrying assertion over the SSE update).
      await expect(pageB.locator(".cone-item")).toHaveCount(baselineB + 1, { timeout: 10000 });

      // One-shot rover position POST (internal header preserved by Caddy only on
      // /course/api/rover/*). Drives the "rover" SSE event → map marker. The
      // marker carries a permanent Leaflet tooltip with className "rover-tooltip".
      const pos = await pageA.request.post("/course/api/rover/position", {
        headers: internalHeaders(),
        data: { lat: 37.5008, lng: 127.0008 },
      });
      expect(pos.ok()).toBeTruthy();

      // Both clients render the rover marker tooltip from the broadcast position.
      await expect(pageB.locator(".rover-tooltip")).toContainText("로버", { timeout: 10000 });
      await expect(pageA.locator(".rover-tooltip")).toContainText("로버", { timeout: 10000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
