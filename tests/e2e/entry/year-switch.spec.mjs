import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;

test.describe("Entry year switching", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed entries for previous year
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post(`/entry/api/entries?year=${PREV_YEAR}`, {
      data: { num: 50, univ: "과거대학교", team: "Past Team", type: "EV" },
    });
    await page.request.post(`/entry/api/entries?year=${PREV_YEAR}`, {
      data: { num: 51, univ: "역사대학교", team: "History Team", type: "CV" },
    });

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/entry/api/entries?year=${PREV_YEAR}`);
    await context.close();
  });

  test("year dropdown shows available years including previous year", async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);

    const yearSelect = page.locator(".year-select");
    await expect(yearSelect).toBeVisible();

    // Current year should be selected by default
    await expect(yearSelect).toHaveValue(String(YEAR));

    // Previous year should be in the options
    const options = yearSelect.locator("option");
    const texts = await options.allTextContents();
    expect(texts).toContain(`${PREV_YEAR}년`);
    expect(texts).toContain(`${YEAR}년`);
  });

  test("switching year shows entries for selected year", async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);

    const table = page.locator(".entry-table");

    // Current year: should show at least 8 seeded entries (may have more from parallel tests)
    await expect.poll(() => table.locator("tbody tr").count()).toBeGreaterThanOrEqual(8);
    await expect(table.locator("tbody")).toContainText("서울대학교");

    // Switch to previous year
    await page.locator(".year-select").selectOption(String(PREV_YEAR));

    // Should show the 2 entries for previous year (isolated data)
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".entry-count")).toHaveText("2개");
    await expect(table.locator("tbody")).toContainText("과거대학교");
    await expect(table.locator("tbody")).toContainText("역사대학교");

    // Switch back to current year
    await page.locator(".year-select").selectOption(String(YEAR));

    await expect.poll(() => table.locator("tbody tr").count()).toBeGreaterThanOrEqual(8);
  });
});
