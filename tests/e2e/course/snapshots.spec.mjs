import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Snapshot lifecycle, exercised purely at the API level as admin (the role the
// snapshot create/restore/delete gates require). Each test seeds its own
// uniquely-named course so it is isolated and parallel-safe.

test.use({ storageState: storageStatePath("admin") });

test.describe("Course snapshots", () => {
  let courseId;

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  async function seedCourse(page, coneCount) {
    const name = `e2e-snap-${Date.now()}-${test.info().parallelIndex}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await page.request.post("/course/api/courses", { data: { name } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const sides = ["left", "center", "right"];
    for (let i = 0; i < coneCount; i++) {
      const res = await page.request.post(`/course/api/courses/${id}/cones`, {
        data: { lat: 37.5 + i * 0.0001, lng: 127.0 + i * 0.0001, side: sides[i % 3] },
      });
      expect(res.status()).toBe(201);
    }
    return id;
  }

  test("create, list, restore reverts cones, and delete", async ({ page }) => {
    courseId = await seedCourse(page, 2);

    // Create a snapshot of the 2-cone state.
    const snapRes = await page.request.post(`/course/api/courses/${courseId}/snapshots`, {
      data: { reason: "e2e baseline" },
    });
    expect(snapRes.status()).toBe(201);
    const snapId = (await snapRes.json()).id;
    expect(typeof snapId).toBe("number");

    // List shows the snapshot we just took (with its cone_count).
    const listRes = await page.request.get(`/course/api/courses/${courseId}/snapshots`);
    expect(listRes.ok()).toBeTruthy();
    let snapshots = (await listRes.json()).snapshots;
    const mine = snapshots.find((s) => s.id === snapId);
    expect(mine).toBeTruthy();
    expect(mine.cone_count).toBe(2);

    // Add a 3rd cone, diverging from the snapshot.
    const add = await page.request.post(`/course/api/courses/${courseId}/cones`, {
      data: { lat: 37.6, lng: 127.1, side: "right" },
    });
    expect(add.status()).toBe(201);
    expect((await page.request.get(`/course/api/courses/${courseId}/cones`).then((r) => r.json())).length).toBe(3);

    // Restore → cones revert to the snapshot's 2.
    const restore = await page.request.post(`/course/api/courses/${courseId}/snapshots/${snapId}/restore`);
    expect(restore.ok()).toBeTruthy();
    expect((await restore.json()).cones.length).toBe(2);
    expect((await page.request.get(`/course/api/courses/${courseId}/cones`).then((r) => r.json())).length).toBe(2);

    // Restore auto-creates a "pre-restore of #<sid>" safety snapshot, so the
    // list now holds at least the original + the auto one (never assert exact).
    snapshots = (await page.request.get(`/course/api/courses/${courseId}/snapshots`).then((r) => r.json())).snapshots;
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.some((s) => s.reason === `pre-restore of #${snapId}`)).toBeTruthy();

    // Delete the original snapshot → 204.
    const del = await page.request.delete(`/course/api/courses/${courseId}/snapshots/${snapId}`);
    expect(del.status()).toBe(204);
  });

  test("snapshot of a cone-less course → 400", async ({ page }) => {
    courseId = await seedCourse(page, 0);
    const res = await page.request.post(`/course/api/courses/${courseId}/snapshots`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test("restore and delete of an unknown snapshot id → 404", async ({ page }) => {
    courseId = await seedCourse(page, 1);
    const restore = await page.request.post(`/course/api/courses/${courseId}/snapshots/999999999/restore`);
    expect(restore.status()).toBe(404);
    const del = await page.request.delete(`/course/api/courses/${courseId}/snapshots/999999999`);
    expect(del.status()).toBe(404);
  });
});
