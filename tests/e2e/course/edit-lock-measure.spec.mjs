import { test, expect } from "@playwright/test";
import { drainBrowserEvents, storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// Edit-lock gating of map-tap cone-add, and the ruler measurement overlay.
// Mobile viewport (bottom-sheet shell), admin. The edit FAB defaults to LOCKED,
// so a map tap must NOT add a cone; unlocking enables it. The ruler tool is
// read-only and usable even while locked.

test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 390, height: 800 },
  hasTouch: true,
});

test.describe("Edit lock + measurement", () => {
  let courseId;

  test.beforeEach(async ({ page }) => {
    const name = `e2e-lock-${Date.now()}-${test.info().parallelIndex}`;
    const created = await page.request.post("/course/api/courses", { data: { name } });
    expect(created.ok()).toBeTruthy();
    courseId = (await created.json()).id;
    // Seed a couple of cones so the active course + cone list render.
    for (const c of [
      { lat: 37.5, lng: 127.0, side: "left" },
      { lat: 37.5003, lng: 127.0003, side: "right" },
    ]) {
      const r = await page.request.post(`/course/api/courses/${courseId}/cones`, { data: c });
      expect(r.ok()).toBeTruthy();
    }

    await page.addInitScript((id) => localStorage.setItem("mapview.activeCourseId", String(id)), courseId);
    await page.goto("/course");
    await waitForPageReady(page);
    await expect(page.locator(".sheet-handle")).toBeVisible();
    await expect(page.locator(".cone-item").first()).toBeAttached();
  });

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("locked: a map tap does not add a cone; unlocked: it does", async ({ page }) => {
    const lock = page.locator(".fab-lock");
    await expect(lock).toHaveClass(/locked/); // default locked

    const baseline = await page.locator(".cone-item").count();

    const mapEl = page.locator("#map");
    const box = await mapEl.boundingBox();
    const tapPos = { x: Math.round(box.width / 2), y: Math.round(box.height * 0.25) };

    // While locked, a tap on empty map space only (possibly) clears selection —
    // it must NOT add a cone. Observe outgoing requests and drain the browser's
    // input/render queue instead of sleeping for a guessed duration.
    const addRequests = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(`/course/api/courses/${courseId}/cones`)) {
        addRequests.push(request.url());
      }
    });
    await mapEl.tap({ position: tapPos });
    await drainBrowserEvents(page);
    expect(addRequests).toHaveLength(0);
    await expect(page.locator(".cone-item")).toHaveCount(baseline);

    // Unlock and tap again → a cone is added.
    await lock.tap();
    await expect(lock).not.toHaveClass(/locked/);
    const addResp = page.waitForResponse(
      (r) => r.url().includes(`/course/api/courses/${courseId}/cones`) && r.request().method() === "POST" && r.status() === 201,
    );
    await mapEl.tap({ position: tapPos });
    await addResp;
    await expect(page.locator(".cone-item")).toHaveCount(baseline + 1);
  });

  test("ruler tool measures a distance and shows the overlay result", async ({ page }) => {
    // The ruler is in the top-right tools panel (read-only; works even locked).
    const ruler = page.locator(".map-fab-tools .fab-tool[aria-label='거리 측정']");
    await expect(ruler).toBeVisible();
    await ruler.tap();
    await expect(ruler).toHaveClass(/active/);

    // The measure overlay appears with its tool name + hint.
    const overlay = page.locator(".measure-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".measure-tool-name")).toContainText("거리");

    // Tap two distinct points on the map. NOTE: rather than computing seeded cone
    // screen pixels (map center/zoom dependent → flaky), we tap two raw map
    // points; the ruler measures any two latlngs (cone-snapping is a 24px
    // convenience, not required for a result). After the 2nd point .measure-result
    // shows the distance.
    const mapEl = page.locator("#map");
    const box = await mapEl.boundingBox();
    await mapEl.tap({ position: { x: Math.round(box.width * 0.35), y: Math.round(box.height * 0.25) } });
    await mapEl.tap({ position: { x: Math.round(box.width * 0.65), y: Math.round(box.height * 0.3) } });

    // The distance result is rendered in the overlay (client-only → auto-retry).
    const result = overlay.locator(".measure-result");
    await expect(result).toBeVisible({ timeout: 5000 });
    await expect(result).toContainText(/\d/);
    await expect(result).toContainText(/m|km/);
  });
});
