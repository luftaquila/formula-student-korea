import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score manual score entry", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
  });

  test("enter report score for a team and verify total updates", async ({ page }) => {
    const table = page.locator("table.score-table");

    // Find the row for team #1 (서울대학교)
    const row = table.locator("tbody tr.team-row").filter({ hasText: "서울대학교" });
    await expect(row).toBeVisible();

    // Get the initial total score
    const totalCell = row.locator(".col-total .total-value");
    const initialTotal = await totalCell.textContent();
    const initialTotalNum = Number(initialTotal);

    // Find the report input (first manual-input in the row)
    const reportInput = row.locator("input.manual-input").nth(0);
    await expect(reportInput).toBeVisible();

    // Enter a report score
    await reportInput.fill("85");
    await reportInput.blur();

    // Wait for the API call and SSE update to propagate
    await page.waitForTimeout(500);

    // Verify total score increased by the report value
    await expect(totalCell).toContainText(String(initialTotalNum + 85));

    // Clean up: reset report score to empty
    await reportInput.fill("");
    await reportInput.blur();
    await page.waitForTimeout(500);
  });

  test("enter energy score for a team", async ({ page }) => {
    const table = page.locator("table.score-table");
    const row = table.locator("tbody tr.team-row").filter({ hasText: "한양대학교" });
    await expect(row).toBeVisible();

    // Energy input is the second manual-input
    const energyInput = row.locator("input.manual-input").nth(1);
    await expect(energyInput).toBeVisible();

    // Enter an energy score
    await energyInput.fill("42");
    await energyInput.blur();
    await page.waitForTimeout(500);

    // Verify the total score includes the energy value
    const totalCell = row.locator(".col-total .total-value");
    const totalText = await totalCell.textContent();
    expect(Number(totalText)).toBeGreaterThanOrEqual(42);

    // Clean up
    await energyInput.fill("");
    await energyInput.blur();
    await page.waitForTimeout(500);
  });

  test("enter bonus and deduction for a team", async ({ page }) => {
    const table = page.locator("table.score-table");
    const row = table.locator("tbody tr.team-row").filter({ hasText: "성균관대학교" });
    await expect(row).toBeVisible();

    const totalCell = row.locator(".col-total .total-value");
    const initialTotal = Number(await totalCell.textContent());

    // Bonus input is the third manual-input
    const bonusInput = row.locator("input.manual-input").nth(2);
    await bonusInput.fill("10");
    await bonusInput.blur();
    await page.waitForTimeout(500);

    // Verify total increased by bonus
    await expect(totalCell).toContainText(String(initialTotal + 10));

    // Deduction input is the fourth manual-input
    const deductionInput = row.locator("input.manual-input").nth(3);
    await deductionInput.fill("5");
    await deductionInput.blur();
    await page.waitForTimeout(500);

    // Verify total = initial + bonus - deduction
    await expect(totalCell).toContainText(String(initialTotal + 10 - 5));

    // Clean up
    await bonusInput.fill("");
    await bonusInput.blur();
    await page.waitForTimeout(300);
    await deductionInput.fill("");
    await deductionInput.blur();
    await page.waitForTimeout(300);
  });

  test("total recalculates when multiple manual scores are set", async ({ page }) => {
    const table = page.locator("table.score-table");
    const row = table.locator("tbody tr.team-row").filter({ hasText: "KAIST" });
    await expect(row).toBeVisible();

    const totalCell = row.locator(".col-total .total-value");

    // Set report = 100, energy = 50, bonus = 20, deduction = 10
    // Expected total contribution from manual = 100 + 50 + 20 - 10 = 160
    const reportInput = row.locator("input.manual-input").nth(0);
    const energyInput = row.locator("input.manual-input").nth(1);
    const bonusInput = row.locator("input.manual-input").nth(2);
    const deductionInput = row.locator("input.manual-input").nth(3);

    await reportInput.fill("100");
    await reportInput.blur();
    await page.waitForTimeout(300);

    await energyInput.fill("50");
    await energyInput.blur();
    await page.waitForTimeout(300);

    await bonusInput.fill("20");
    await bonusInput.blur();
    await page.waitForTimeout(300);

    await deductionInput.fill("10");
    await deductionInput.blur();
    await page.waitForTimeout(500);

    // Verify total is at least 160 (may include event scores)
    const totalText = await totalCell.textContent();
    expect(Number(totalText)).toBeGreaterThanOrEqual(160);

    // Clean up all manual scores
    for (const input of [reportInput, energyInput, bonusInput, deductionInput]) {
      await input.fill("");
      await input.blur();
      await page.waitForTimeout(200);
    }
  });
});
