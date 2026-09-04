import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// Cone + course CRUD through the MapView SPA UI on a mobile viewport (the bottom
// -sheet layout). Each mutation is awaited via waitForResponse on its API call so
// the test is deterministic (no fixed sleeps). Shared lists are asserted through
// our own unique data, while cone counts remain scoped to the active course.

test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 390, height: 800 },
  hasTouch: true,
});

test.describe("Course + cone CRUD (UI)", () => {
  let courseId;

  test.beforeEach(async ({ page }) => {
    const name = `e2e-crud-${Date.now()}-${test.info().parallelIndex}`;
    const created = await page.request.post("/course/api/courses", { data: { name } });
    expect(created.ok()).toBeTruthy();
    courseId = (await created.json()).id;
    // Seed one cone so the cone list + selection paths have something to render.
    const seedCone = await page.request.post(`/course/api/courses/${courseId}/cones`, {
      data: { lat: 37.5, lng: 127.0, side: "left" },
    });
    expect(seedCone.ok()).toBeTruthy();

    // Pin our course as active so the test is isolated from other DB courses.
    await page.addInitScript((id) => {
      localStorage.setItem("mapview.activeCourseId", String(id));
    }, courseId);

    await page.goto("/course");
    await waitForPageReady(page);
    // Sheet handle confirms the mobile shell; our cone row is in the DOM (clipped
    // while collapsed) confirming the active course + its cones rendered.
    await expect(page.locator(".sheet-handle")).toBeVisible();
    await expect(page.locator(".cone-item").first()).toBeAttached();
  });

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("tapping the map adds a cone once edit is unlocked", async ({ page }) => {
    // The edit FAB defaults to locked (🔒). Unlock it so a map tap adds a cone.
    const lock = page.locator(".fab-lock");
    await expect(lock).toBeVisible();
    await expect(lock).toHaveClass(/locked/);
    await lock.tap();
    await expect(lock).not.toHaveClass(/locked/);

    const baseline = await page.locator(".cone-item").count();

    // A tap on the map (not on the collapsed sheet/FABs) fires Leaflet's click →
    // onMapClick → addCone(currentSide). Tap near the top-center of the map.
    const mapEl = page.locator("#map");
    const box = await mapEl.boundingBox();
    const addResp = page.waitForResponse(
      (r) => r.url().includes(`/course/api/courses/${courseId}/cones`) && r.request().method() === "POST" && r.status() === 201,
    );
    await mapEl.tap({ position: { x: Math.round(box.width / 2), y: Math.round(box.height * 0.25) } });
    await addResp;

    // The list grows by exactly the cone we added (SSE-driven reactive list).
    await expect(page.locator(".cone-item")).toHaveCount(baseline + 1);
  });

  test("deleting a cone via its row × removes it", async ({ page }) => {
    const baseline = await page.locator(".cone-item").count();
    expect(baseline).toBeGreaterThanOrEqual(1);

    const delResp = page.waitForResponse(
      (r) => /\/course\/api\/cones\/\d+/.test(r.url()) && r.request().method() === "DELETE" && r.status() === 200,
    );
    // The first cone row's delete button (.del-btn lives inside .cone-item).
    await page.locator(".cone-item").first().locator(".del-btn").tap();
    await delResp;

    await expect(page.locator(".cone-item")).toHaveCount(baseline - 1);
  });

  test("creating a course via the new-course input + add button", async ({ page }) => {
    const newName = `e2e-crud-new-${Date.now()}-${test.info().parallelIndex}`;
    // .course-add also holds a hidden file input (inline JSON import), so target
    // the named text input specifically.
    await page.locator('.course-add input[placeholder="새 코스 이름"]').fill(newName);

    const createResp = page.waitForResponse(
      (r) => r.url().includes("/course/api/courses") && r.request().method() === "POST" && r.status() === 201,
    );
    // The + button is the primary add button in .course-add.
    await page.locator(".course-add button[title='코스 추가']").tap();
    const created = await createResp;
    const newCourseId = (await created.json()).id;

    // Our named course appears through the SSE-driven list update. Do not assert
    // the global count: another Course worker may create its own isolated row.
    await expect(page.locator(".course-item").filter({ hasText: newName })).toBeVisible();

    // Cleanup the extra course this test created.
    await page.request.delete(`/course/api/courses/${newCourseId}`);
  });

  test("renaming our course via double-click inline edit", async ({ page }) => {
    // Our seeded course is the pinned active one — target it by the active class
    // (parallel-safe: each worker pins its own course).
    const row = page.locator(".course-item.active");
    await expect(row).toBeVisible();

    const newName = `e2e-crud-renamed-${Date.now()}-${test.info().parallelIndex}`;
    // Double-click the name span to enter inline edit (startEditCourse).
    await row.locator(".course-name").dblclick();
    const editInput = row.locator(".course-name-input");
    await expect(editInput).toBeVisible();
    await editInput.fill(newName);

    const renameResp = page.waitForResponse(
      (r) => new RegExp(`/course/api/courses/${courseId}$`).test(r.url()) && r.request().method() === "PATCH" && r.status() === 200,
    );
    await row.locator("button:has-text('저장')").click();
    await renameResp;

    await expect(page.locator(".course-item").filter({ hasText: newName })).toBeVisible();
  });

  test("toggling course visibility via the eye button", async ({ page }) => {
    // The visibility button is a client-only toggle (no API call) — assert via
    // the title attribute that flips between 숨기기 (visible) and 표시 (hidden).
    const row = page.locator(".course-item.active");
    await expect(row).toBeVisible();
    const visBtn = row.locator(".vis-btn");
    // Default visible → title 숨기기.
    await expect(visBtn).toHaveAttribute("title", "숨기기");
    await visBtn.tap();
    await expect(visBtn).toHaveAttribute("title", "표시");
    await visBtn.tap();
    await expect(visBtn).toHaveAttribute("title", "숨기기");
  });
});
