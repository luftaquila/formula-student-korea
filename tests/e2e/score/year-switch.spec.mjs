import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const PREV_YEAR = YEAR - 1;

async function exposePreviousYear(page) {
  await page.route("**/competition/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    await route.fulfill({
      response,
      json: { ...meta, years: [...new Set([...meta.years, PREV_YEAR])].sort((a, b) => b - a) },
    });
  });
}

test.describe("Score year switch and read-only mode", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("keeps historical reads available and rejects historical mutations", async ({ page }) => {
    const teams = await page.request.get(`/competition/api/v1/teams?year=${PREV_YEAR}`);
    expect(teams.status()).toBe(200);
    expect(Array.isArray(await teams.json())).toBe(true);

    const scoreWrite = await page.request.put("/competition/api/v1/score/manual", {
      data: { year: PREV_YEAR, team_num: 1, score_type: "report", value: 1 },
    });
    expect(scoreWrite.status()).toBe(409);
    expect((await scoreWrite.json()).code).toBe("YEAR_READ_ONLY");
  });

  test("dashboard: year switch shows read-only mode", async ({ page }) => {
    await exposePreviousYear(page);
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

    // Every rendered manual input must be disabled. Historical years can be empty.
    const manualInputs = page.locator("input.manual-input");
    const inputCount = await manualInputs.count();
    for (let i = 0; i < inputCount; i++) {
      await expect(manualInputs.nth(i)).toBeDisabled();
    }

    // Switch back to current year
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);

    // Banner should disappear
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
  });

  test("endurance: year switch shows read-only mode", async ({ page }) => {
    await exposePreviousYear(page);
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

    // Every rendered control must be disabled. Historical years can be empty.
    const timeInputs = page.locator("input.time-input");
    const timeCount = await timeInputs.count();
    for (let i = 0; i < timeCount; i++) {
      await expect(timeInputs.nth(i)).toBeDisabled();
    }

    const numInputs = page.locator("input.num-input");
    const numCount = await numInputs.count();
    for (let i = 0; i < numCount; i++) {
      await expect(numInputs.nth(i)).toBeDisabled();
    }

    const statusBtns = page.locator(".status-btn");
    const btnCount = await statusBtns.count();
    for (let i = 0; i < btnCount; i++) {
      await expect(statusBtns.nth(i)).toBeDisabled();
    }

    // Switch back
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
  });
});
