import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { drainBrowserEvents, storageStatePath } from "../helpers/utils.mjs";

const cones = JSON.parse(readFileSync(new URL("../../course/fixtures/endurance.json", import.meta.url))).cones;

test.describe("Public race courses", () => {
  test.describe.configure({ retries: 0 });
  test("a visitor measures and downloads a snapshot, then refreshes to see publication changes", async ({ browser }) => {
    const admin = await browser.newContext({ storageState: storageStatePath("admin") });
    const visitor = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const name = `e2e-public-course-${test.info().parallelIndex}-${Date.now()}`;
    let id;
    try {
      const created = await admin.request.post("/course/api/courses/import", { data: { name, cones } });
      expect(created.status()).toBe(201);
      id = (await created.json()).id;
      const operatorPage = await admin.newPage();
      await operatorPage.goto("/course");
      const row = operatorPage.locator(".course-item").filter({ hasText: name });
      await expect(row).toBeVisible();
      const published = operatorPage.waitForResponse((response) => response.url().endsWith(`/courses/${id}/publication`) && response.request().method() === "PATCH");
      await row.getByRole("button", { name: "코스 공개", exact: true }).click();
      expect((await published).status()).toBe(200);

      const page = await visitor.newPage();
      const courseRequests = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/course/api/")) courseRequests.push(request);
      });
      await page.goto("/");
      await page.getByRole("link", { name: /경기 코스/ }).click();
      await expect(page).toHaveURL(/\/course\/public\/?$/);
      await expect(page.getByRole("banner").getByRole("heading", { name: "FSK 경기 코스" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "코스 목록", exact: true })).toBeVisible();
      const selection = page.getByRole("button", { name: new RegExp(`^${name} `) });
      await selection.click();
      await expect(selection).toHaveAttribute("aria-pressed", "true");
      await expect(selection).toHaveText(new RegExp(`${name} \\(\\d+m\\)`));
      const tools = page.getByRole("group", { name: "코스 도구" });
      await expect(tools.getByRole("button")).toHaveCount(4);
      const selectionLines = await selection.evaluate((button) => {
        const name = button.querySelector(".public-course-name");
        const length = button.querySelector(".public-course-length");
        const text = document.createRange();
        text.selectNodeContents(name);
        return { lines: new Set(Array.from(text.getClientRects(), (rect) => Math.round(rect.y))).size, nameY: name.getBoundingClientRect().y, lengthY: length.getBoundingClientRect().y, lineHeight: name.getBoundingClientRect().height };
      });
      expect(selectionLines.lines).toBe(1);
      const titleBox = await selection.boundingBox();
      const card = page.getByRole("listitem").filter({ has: selection });
      const cardBox = await card.boundingBox();
      // A full-width title and a separate action row must still fit a compact card.
      expect(cardBox.height).toBeLessThanOrEqual(76);
      for (const action of [card.getByRole("button", { name: "코스 표시", exact: true }), card.getByRole("button", { name: "Asseto Corsa 트랙 다운로드", exact: true })]) {
        const actionBox = await action.boundingBox();
        expect(actionBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      }
      expect(titleBox.width).toBeGreaterThan(cardBox.width * .85);
      expect(Math.abs(selectionLines.nameY - selectionLines.lengthY)).toBeLessThan(selectionLines.lineHeight / 2);
      const protractorBox = await tools.getByRole("button", { name: "각도 측정" }).boundingBox();
      const rotateBox = await tools.getByRole("button", { name: "지도 90° 회전", exact: true }).boundingBox();
      expect(rotateBox.x).toBeGreaterThanOrEqual(protractorBox.x + protractorBox.width);
      expect(rotateBox.y).toBe(protractorBox.y);
      const map = page.getByLabel("경기 코스 지도", { exact: true });
      const bounds = await map.boundingBox();
      expect(bounds).not.toBeNull();
      await tools.getByRole("button", { name: "거리 측정" }).click();
      const reset = page.getByRole("button", { name: "측정 초기화" });
      const close = page.getByRole("button", { name: "측정 닫기" });
      const resetBox = await reset.boundingBox();
      const closeBox = await close.boundingBox();
      for (const control of [reset, close]) {
        const spacing = await control.evaluate((button) => {
          const outer = button.getBoundingClientRect();
          const icon = button.firstElementChild.getBoundingClientRect();
          return { width: outer.width, height: outer.height, iconWidth: icon.width, iconHeight: icon.height, paddingX: icon.x - outer.x, paddingY: icon.y - outer.y };
        });
        expect(spacing.width).toBeGreaterThanOrEqual(44);
        expect(spacing.height).toBeGreaterThanOrEqual(44);
        expect(spacing.iconWidth).toBe(spacing.iconHeight);
        expect(spacing.paddingX).toBeGreaterThanOrEqual(8);
        expect(spacing.paddingY).toBeGreaterThanOrEqual(8);
      }
      expect(closeBox.x - resetBox.x - resetBox.width).toBeGreaterThanOrEqual(8);
      await map.tap({ position: { x: bounds.width * .30, y: bounds.height * .4 } });
      await map.tap({ position: { x: bounds.width * .65, y: bounds.height * .5 } });
      await expect(page.getByRole("status").filter({ hasText: /\d+\.\d+ (m|km)/ })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("public-course-layout.png") });
      await tools.getByRole("button", { name: "각도 측정" }).click();
      for (const [x, y] of [[.25, .4], [.5, .5], [.65, .3]]) await map.tap({ position: { x: bounds.width * x, y: bounds.height * y } });
      await expect(page.getByRole("status").filter({ hasText: /∠ .*°/ })).toBeVisible();

      await page.getByRole("button", { name: "측정 닫기" }).click();
      const bearing = () => map.locator(".leaflet-rotate-pane").evaluate((pane) => {
        const angle = pane.style.transform.match(/rotate\(([-\d.]+)rad\)/);
        return angle ? Number(angle[1]) : null;
      });
      const north = await bearing();
      await page.getByRole("button", { name: "지도 90° 회전", exact: true }).click();
      await expect.poll(bearing).not.toBe(north);
      const rotated = await bearing();
      await tools.getByRole("button", { name: "중심선 표시" }).click();
      await page.reload();
      await expect(selection).toHaveAttribute("aria-pressed", "true");
      await expect(tools.getByRole("button", { name: "중심선 표시" })).toHaveAttribute("aria-pressed", "false");
      await expect.poll(bearing).toBe(rotated);
      const listReads = courseRequests.filter((request) => new URL(request.url()).pathname === "/course/api/public/courses").length;

      const publicRow = page.getByRole("listitem").filter({ has: selection });
      const downloaded = page.waitForEvent("download");
      await publicRow.getByRole("button", { name: "Asseto Corsa 트랙 다운로드", exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(`${name}.zip`);
      expect(await download.failure()).toBeNull();
      // Archive contents are tested below the browser; this asserts delivery
      // through the real public page and proxy without operator API calls.
      await drainBrowserEvents(page);
      expect(courseRequests.length).toBeGreaterThan(0);
      expect(courseRequests.every((request) => request.method() === "GET" && new URL(request.url()).pathname.startsWith("/course/api/public/"))).toBe(true);

      const revoked = operatorPage.waitForResponse((response) => response.url().endsWith(`/courses/${id}/publication`) && response.request().method() === "PATCH");
      await row.getByRole("button", { name: "공개 해제", exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await drainBrowserEvents(page);
      await expect(selection).toBeVisible();
      expect(courseRequests.filter((request) => new URL(request.url()).pathname === "/course/api/public/courses")).toHaveLength(listReads);
      expect(courseRequests.some((request) => request.resourceType() === "eventsource")).toBe(false);
      await page.reload();
      await expect(selection).toHaveCount(0);
    } finally {
      if (id) await admin.request.delete(`/course/api/courses/${id}`);
      await visitor.close();
      await admin.close();
    }
  });

  test("a course without enough boundary cones remains usable without a centerline diagnostic", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const course = { id: 1, name: "Sparse course", cone_count: 2 };
      const detail = {
        course,
        cones: [
          { id: 1, side: "left", lat: 35.292, lng: 126.574 },
          { id: 2, side: "right", lat: 35.2921, lng: 126.5741 },
        ],
        route: { markers: [], steps: [] },
      };
      await context.route("**/course/api/public/courses", (route) => route.fulfill({ json: [course] }));
      await context.route("**/course/api/public/courses/1", (route) => route.fulfill({ json: detail }));
      const page = await context.newPage();
      await page.goto("/course/public");
      await expect(page.getByRole("button", { name: course.name, exact: true })).toHaveAttribute("aria-pressed", "true");
      const inspector = page.getByRole("complementary", { name: "공개 코스" });
      await expect(inspector.getByRole("status")).toHaveCount(0);
      await expect(inspector.getByRole("alert")).toHaveCount(0);
      await page.getByRole("button", { name: "중심선 표시", exact: true }).click();
      await expect(inspector.getByRole("status")).toHaveCount(0);
      await page.getByRole("button", { name: "거리 측정", exact: true }).click();
      await expect(page.getByRole("button", { name: "측정 닫기", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("an admin visiting the public URL still has only public course tools and requests", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const name = `e2e-public-admin-${test.info().parallelIndex}-${Date.now()}`;
    let id;
    try {
      const created = await context.request.post("/course/api/courses/import", { data: { name, cones } });
      expect(created.status()).toBe(201);
      id = (await created.json()).id;
      expect((await context.request.patch(`/course/api/courses/${id}/publication`, { data: { is_public: true } })).status()).toBe(200);
      const page = await context.newPage();
      const privateRequests = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/course/api/") && !path.startsWith("/course/api/public/")) privateRequests.push(path);
      });
      await page.goto("/course/public");
      await page.getByRole("button", { name: new RegExp(`^${name} `) }).click();
      await expect(page.getByRole("group", { name: "코스 도구" }).getByRole("button")).toHaveCount(4);
      await drainBrowserEvents(page);
      expect(privateRequests).toEqual([]);
    } finally {
      if (id) await context.request.delete(`/course/api/courses/${id}`);
      await context.close();
    }
  });
});
