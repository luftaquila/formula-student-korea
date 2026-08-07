import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable, enduranceTable } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Endurance DSQ -> Score dashboard exclusion", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    // Clear DSQ for team 20
    await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: 20, field: "status", value: null },
    });
    await context.close();
  });

  test("DSQ on endurance page disables inputs", async ({ page }) => {
    // Ensure DSQ is cleared first via API
    await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: 20, field: "status", value: null },
    });

    await page.goto("/score/endurance");
    await waitForPageReady(page);

    const table = enduranceTable(page);
    const row = table.locator("tbody tr").filter({ hasText: "고려대학교" });
    await expect(row).toBeVisible();

    // If DSQ is still active after API clear (SSE race), click to toggle off first
    const dsqBtn = row.locator(".status-btn").filter({ hasText: "DSQ" });
    const isActive = await dsqBtn.evaluate((el) => el.classList.contains("active"));
    if (isActive) {
      await dsqBtn.click();
      await expect(dsqBtn).not.toHaveClass(/active/);
    }

    // Now click DSQ button to enable
    await dsqBtn.click();
    await expect(dsqBtn).toHaveClass(/active/);

    // Verify inputs are disabled
    const inputs = row.locator("input.cell-input");
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }

    // Verify final record shows "DSQ"
    await expect(row.locator(".record-value.dnf")).toContainText("DSQ");
  });

  test("DSQ team shows DNF on score dashboard", async ({ page }) => {
    // Ensure DSQ is set via API (in case previous test ordering)
    await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: 20, field: "status", value: "DSQ" },
    });

    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    const teamRow = table.locator("tr.team-row").filter({ hasText: "고려대학교" });
    await expect(teamRow).toBeVisible();

    // Expand detail to check endurance — DSQ maps to result=-1 which shows "DNF"
    await teamRow.click();
    const detailRow = teamRow.locator("+ tr.detail-row");

    // The endurance column in the team row should show "DNF"
    await expect(async () => {
      const rowText = await teamRow.textContent();
      expect(rowText).toContain("DNF");
    }).toPass({ timeout: 10000 });

    // Collapse
    await teamRow.click();
  });

  test("clearing DSQ removes DNF from score dashboard", async ({ page }) => {
    // Clear DSQ
    await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: 20, field: "status", value: null },
    });

    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    const teamRow = table.locator("tr.team-row").filter({ hasText: "고려대학교" });
    await expect(teamRow).toBeVisible();

    // DNF should no longer appear for endurance; should show "-" or empty
    await expect(async () => {
      const rowText = await teamRow.textContent();
      expect(rowText).not.toContain("DNF");
    }).toPass({ timeout: 10000 });
  });
});
