import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// Mobile viewport (isMobile = innerWidth <= 768) so the inspector renders as a
// bottom sheet with the drag/tap handle, and hasTouch so .tap() dispatches real
// touch events (the trigger for the browser's compatibility "ghost" click).
test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 390, height: 800 },
  hasTouch: true,
});

test.describe("Course bottom sheet expand", () => {
  let courseId;

  test.beforeEach(async ({ page }) => {
    // Seed a course with enough cones that the list fills the area the handle
    // sat over before expanding — the rows a ghost tap would land on.
    const name = `e2e-sheet-${Date.now()}-${test.info().parallelIndex}`;
    const created = await page.request.post("/course/api/courses", { data: { name } });
    expect(created.ok()).toBeTruthy();
    courseId = (await created.json()).id;

    const sides = ["left", "center", "right"];
    for (let i = 0; i < 15; i++) {
      const res = await page.request.post(`/course/api/courses/${courseId}/cones`, {
        data: { lat: 37.5 + i * 0.0002, lng: 127.0 + i * 0.0002, side: sides[i % 3] },
      });
      expect(res.ok()).toBeTruthy();
    }

    // Pin our seeded course as the active one (the app restores this pref on
    // load) so the test is isolated from any other courses in the DB.
    await page.addInitScript((id) => {
      localStorage.setItem("mapview.activeCourseId", String(id));
    }, courseId);

    await page.goto("/course");
    await waitForPageReady(page);
    // Sheet starts collapsed, so the rows are in the DOM but clipped — assert
    // the first cone row is attached (not visible) to confirm the active course
    // and its cone list rendered.
    await expect(page.locator(".sheet-handle")).toBeVisible();
    await expect(page.locator(".cone-item").first()).toBeAttached();
  });

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("tap-to-expand does not ghost-tap a course/cone underneath", async ({ page }) => {
    const inspector = page.locator(".inspector");
    const handle = page.locator(".sheet-handle");

    // Sheet starts collapsed (handle only, ~52px) with nothing selected.
    expect((await inspector.boundingBox()).height).toBeLessThan(80);
    await expect(page.locator(".cone-item.selected")).toHaveCount(0);

    // A touchscreen tap emits only touch events, so the ONLY click that can
    // appear afterwards is the browser's synthetic compatibility click. Record
    // every click (capture phase) and flag the ones landing on a course/cone row
    // — the exact symptom being guarded against.
    await page.evaluate(() => {
      window.__clicks = [];
      document.addEventListener(
        "click",
        (e) => {
          const onRow = e.target.closest && e.target.closest(".course-item, .cone-item");
          window.__clicks.push(onRow ? "row" : "other");
        },
        true,
      );
    });

    await handle.tap();

    // Expansion is driven synchronously by the tap; poll the height to confirm.
    await expect.poll(async () => (await inspector.boundingBox()).height).toBeGreaterThan(120);

    // Asserting the ABSENCE of an event needs a bounded wait: a compatibility
    // click, if the browser were to generate one, is dispatched right after the
    // tap's touchend. This is not an API/save wait.
    await page.waitForTimeout(500);

    const clicks = await page.evaluate(() => window.__clicks);
    expect(clicks, `ghost click(s) fired after tap-to-expand: ${JSON.stringify(clicks)}`).toEqual([]);
    // And the user-visible symptom: no cone got selected by the tap.
    await expect(page.locator(".cone-item.selected")).toHaveCount(0);
  });

  test("the handle still toggles the sheet open and closed", async ({ page }) => {
    const inspector = page.locator(".inspector");
    const handle = page.locator(".sheet-handle");

    expect((await inspector.boundingBox()).height).toBeLessThan(80);

    await handle.tap();
    await expect.poll(async () => (await inspector.boundingBox()).height).toBeGreaterThan(120);

    await handle.tap();
    await expect.poll(async () => (await inspector.boundingBox()).height).toBeLessThan(80);
  });
});
