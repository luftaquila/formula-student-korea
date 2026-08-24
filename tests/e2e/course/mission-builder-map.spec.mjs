import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 1280, height: 800 },
});

test.describe("Mission builder map lifecycle", () => {
  let courseId;

  test.beforeEach(async ({ page }) => {
    const name = `e2e-mission-map-${Date.now()}-${test.info().parallelIndex}`;
    const created = await page.request.post("/course/api/courses", { data: { name } });
    expect(created.ok()).toBeTruthy();
    courseId = (await created.json()).id;
    for (const cone of [
      { lat: 37.5, lng: 127.0, side: "left" },
      { lat: 37.5001, lng: 127.0002, side: "center" },
      { lat: 37.5002, lng: 127.0, side: "right" },
    ]) {
      const response = await page.request.post(`/course/api/courses/${courseId}/cones`, { data: cone });
      expect(response.ok()).toBeTruthy();
    }
    const markerResponse = await page.request.post(`/course/api/courses/${courseId}/route/markers`, {
      data: { lat: 37.5001, lng: 127.0001, label: "교차점" },
    });
    expect(markerResponse.ok()).toBeTruthy();
    const routeMarkerId = (await markerResponse.json()).id;
    const routeResponse = await page.request.put(`/course/api/courses/${courseId}/route/steps`, {
      data: { steps: [routeMarkerId] },
    });
    expect(routeResponse.ok()).toBeTruthy();
    await page.addInitScript((id) => {
      localStorage.setItem("mapview.activeCourseId", String(id));
      localStorage.setItem("mapview.mapBearing", "270");
      localStorage.setItem("mapview.showCenterline", "true");
    }, courseId);
    await page.goto("/course");
    await waitForPageReady(page);
    await expect(page.locator("#map .leaflet-rotate-pane")).toBeAttached();
  });

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("inherits the main bearing and disposes its second Leaflet map on close", async ({ page }) => {
    const paneBearing = (selector) => page.locator(selector).evaluate((pane) => {
      const match = pane.style.transform.match(/rotate\(([-\d.]+)rad\)/);
      return match ? Number(match[1]) : null;
    });

    await page.locator(".rail-btn[title='로버']").click();
    await page.getByRole("button", { name: "경로 계산" }).click();

    const dialog = page.getByRole("dialog", { name: "미션 경로 편집" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".map-wrap")).toHaveClass(/map-suspended/);
    await expect(page.locator("#map")).toHaveClass(/leaflet-container/);
    await expect(dialog.getByRole("button", { name: /90° 회전/ })).toHaveCount(0);
    await expect(page.locator(".leaflet-container")).toHaveCount(2);
    await expect.poll(async () => {
      const mainBearing = await paneBearing("#map .leaflet-rotate-pane");
      const builderBearing = await paneBearing(".builder-map .leaflet-rotate-pane");
      return mainBearing == null || builderBearing == null
        ? Number.POSITIVE_INFINITY
        : Math.abs(mainBearing - builderBearing);
    }).toBeLessThan(1e-9);

    await dialog.getByRole("button", { name: "닫기" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".map-wrap")).not.toHaveClass(/map-suspended/);
    await expect(page.locator("#map")).toHaveClass(/leaflet-container/);
    await expect(page.locator(".leaflet-container")).toHaveCount(1);
  });

  test("hides centered route markers with the course graphic", async ({ page }) => {
    await page.locator(".rail-btn[title='코스']").click();

    const routeMarker = page.locator(".route-marker-pin");
    await expect(routeMarker).toBeVisible();
    await expect(routeMarker).toHaveCSS("border-radius", "50%");
    await expect(routeMarker).toHaveCSS("transform", "none");

    const centerlineButton = page.getByRole("button", { name: "중심선 표시" });
    await centerlineButton.click();
    await expect(routeMarker).toHaveCount(0);

    await centerlineButton.click();
    await expect(routeMarker).toBeVisible();

    const visibilityButton = page.locator(".course-item.active .vis-btn");
    await visibilityButton.click();
    await expect(routeMarker).toHaveCount(0);
  });
});
