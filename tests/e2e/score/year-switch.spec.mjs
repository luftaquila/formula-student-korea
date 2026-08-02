import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;

test.describe("Score year switch and read-only mode", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed vehicle types and entry for previous year
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post(`/entry/api/vehicle-types?year=${PREV_YEAR}`, { data: { name: "EV" } });
    await page.request.post(`/entry/api/entries?year=${PREV_YEAR}`, {
      data: { num: 81, univ: "과거성적대학교", team: "Old Score Team", type: "EV" },
    });

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/entry/api/entries?year=${PREV_YEAR}`);
    await context.close();
  });

  test("dashboard: year switch shows read-only banner and disables inputs", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);

    // Current year should have no read-only banner
    await expect(page.locator(".readonly-banner")).not.toBeVisible();

    // Year dropdown should be visible
    const yearSelect = page.locator(".filter-bar select.filter-input").first();
    await expect(yearSelect).toBeVisible();

    // Switch to previous year
    await yearSelect.selectOption(String(PREV_YEAR));
    await waitForPageReady(page);

    // Read-only banner should appear
    await expect(page.locator(".readonly-banner")).toBeVisible();
    await expect(page.locator(".readonly-banner")).toContainText("읽기 전용");

    // Should show the 1 entry for previous year
    const table = page.locator("table.score-table");
    await expect(table.locator("tbody")).toContainText("과거성적대학교");

    // Manual score input fields should be disabled
    const manualInputs = table.locator("input.manual-input");
    const inputCount = await manualInputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < inputCount; i++) {
      await expect(manualInputs.nth(i)).toBeDisabled();
    }

    // Switch back to current year
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);

    // Banner should disappear
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
  });

  test("endurance: year switch shows read-only banner and disables inputs", async ({ page }) => {
    await page.goto("/score/endurance");
    await waitForPageReady(page);

    // Current year: no read-only banner
    await expect(page.locator(".readonly-banner")).not.toBeVisible();

    // Switch to previous year
    const yearSelect = page.locator(".filter-bar select.filter-input").first();
    await yearSelect.selectOption(String(PREV_YEAR));
    await waitForPageReady(page);

    // Read-only banner should appear
    await expect(page.locator(".readonly-banner")).toBeVisible();
    await expect(page.locator(".readonly-banner")).toContainText("읽기 전용");

    // Should show previous year's entry
    const table = page.locator("table.endurance-table");
    await expect(table.locator("tbody")).toContainText("과거성적대학교");

    // Time inputs should be disabled
    const timeInputs = table.locator("input.time-input");
    const timeCount = await timeInputs.count();
    expect(timeCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < timeCount; i++) {
      await expect(timeInputs.nth(i)).toBeDisabled();
    }

    // Number inputs should be disabled
    const numInputs = table.locator("input.num-input");
    const numCount = await numInputs.count();
    expect(numCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < numCount; i++) {
      await expect(numInputs.nth(i)).toBeDisabled();
    }

    // Status buttons (DNS/DNF/DSQ) should be disabled
    const statusBtns = table.locator(".status-btn");
    const btnCount = await statusBtns.count();
    expect(btnCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < btnCount; i++) {
      await expect(statusBtns.nth(i)).toBeDisabled();
    }

    // Switch back
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
  });
});
