import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const ISOLATED_YEAR = YEAR - 3;

test.describe("Entry delete all", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed vehicle types and entries in an isolated year to avoid interfering with other tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.post(`/entry/api/vehicle-types?year=${ISOLATED_YEAR}`, { data: { name: "EV" } });
    await page.request.post(`/entry/api/vehicle-types?year=${ISOLATED_YEAR}`, { data: { name: "CV" } });
    const entries = [
      { num: 1, univ: "서울대학교", team: "SNU Racing", type: "EV" },
      { num: 2, univ: "한양대학교", team: "ACES", type: "EV" },
      { num: 3, univ: "성균관대학교", team: "SKKU Racing", type: "CV" },
    ];
    for (const entry of entries) {
      await page.request.post(`/entry/api/entries?year=${ISOLATED_YEAR}`, { data: entry });
    }
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/entry/api/entries?year=${ISOLATED_YEAR}`);
    await context.close();
  });

  test("delete all entries and verify empty state", async ({ page }) => {
    await page.goto("/entry");
    await page.waitForLoadState("networkidle");

    // Switch to isolated year
    await page.locator(".year-select").selectOption(String(ISOLATED_YEAR));
    await page.waitForLoadState("networkidle");

    const table = page.locator(".entry-table");

    // Verify we have 3 entries before deletion
    await expect(page.locator(".entry-count")).toHaveText("3대");

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Click the "전체 삭제" button
    const deleteAllBtn = page.locator(".delete-all-btn");
    await expect(deleteAllBtn).toBeVisible();
    await deleteAllBtn.click();

    // Verify all entries are gone
    await expect(table.locator("tbody")).toContainText("등록된 엔트리가 없습니다");
    await expect(page.locator(".entry-count")).toHaveText("0대");
  });
});
