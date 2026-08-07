import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

async function fillAndSave(page, input, value) {
  const savePromise = page.waitForResponse((res) => res.url().includes("/api/score/manual") && res.status() === 200);
  // 사용자가 실제로 하는 동작 그대로 둔다. 리렌더링이 타이핑 중인 값을 덮어쓰면 저장이
  // 나가지 않고 여기서 타임아웃 나야 한다 — 그게 이 테스트가 잡아야 하는 회귀다.
  await input.click();
  await input.fill(value);
  await input.blur();
  await savePromise;
}

test.describe("Score manual score entry", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
  });

  test("enter report score for a team and verify total updates", async ({ page }) => {
    const table = scoreTable(page);

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
    await fillAndSave(page, reportInput, "85");

    // Verify total score increased by the report value
    await expect(totalCell).toContainText(String(initialTotalNum + 85));

    // Clean up: reset report score to empty
    await fillAndSave(page, reportInput, "");
  });

  test("energy score is read-only and automatically calculated", async ({ page }) => {
    const table = scoreTable(page);
    const row = table.locator("tbody tr.team-row").filter({ hasText: "한양대학교" });
    await expect(row).toBeVisible();

    const energyCell = row.locator("td.col-manual").nth(1);
    await expect(energyCell).toBeVisible();
    await expect(energyCell.locator("input")).toHaveCount(0);
  });

  test("enter bonus and deduction for a team", async ({ page }) => {
    const table = scoreTable(page);
    const row = table.locator("tbody tr.team-row").filter({ hasText: "성균관대학교" });
    await expect(row).toBeVisible();

    const totalCell = row.locator(".col-total .total-value");
    const initialTotal = Number(await totalCell.textContent());

    // Energy is read-only, so bonus is the second manual input.
    const bonusInput = row.locator("input.manual-input").nth(1);
    await fillAndSave(page, bonusInput, "10");

    // Verify total increased by bonus
    await expect(totalCell).toContainText(String(initialTotal + 10));

    const deductionInput = row.locator("input.manual-input").nth(2);
    await fillAndSave(page, deductionInput, "5");

    // Verify total = initial + bonus - deduction
    await expect(totalCell).toContainText(String(initialTotal + 10 - 5));

    // Clean up
    await fillAndSave(page, bonusInput, "");
    await fillAndSave(page, deductionInput, "");
  });

  test("arrow keys move focus between manual score cells", async ({ page }) => {
    const table = scoreTable(page);
    const rows = table.locator("tbody tr.team-row");
    await expect(rows.first()).toBeVisible();

    const firstRow = rows.nth(0);
    const report = firstRow.locator("input.manual-input").nth(0);
    const bonus = firstRow.locator("input.manual-input").nth(1);
    const deduction = firstRow.locator("input.manual-input").nth(2);

    // ArrowRight walks report -> bonus -> deduction (energy is read-only).
    await report.focus();
    await report.press("ArrowRight");
    await expect(bonus).toBeFocused();
    await bonus.press("ArrowRight");
    await expect(deduction).toBeFocused();

    // ArrowLeft goes back
    await deduction.press("ArrowLeft");
    await expect(bonus).toBeFocused();

    // ArrowDown moves to the next team row, same column
    const secondRowReport = rows.nth(1).locator("input.manual-input").nth(0);
    await report.focus();
    await report.press("ArrowDown");
    await expect(secondRowReport).toBeFocused();
  });

  test("total recalculates when multiple manual scores are set", async ({ page }) => {
    const table = scoreTable(page);
    const row = table.locator("tbody tr.team-row").filter({ hasText: "KAIST" });
    await expect(row).toBeVisible();

    const totalCell = row.locator(".col-total .total-value");

    // Set report = 100, bonus = 20, deduction = 10.
    // Energy remains an independently calculated, read-only contribution.
    const reportInput = row.locator("input.manual-input").nth(0);
    const bonusInput = row.locator("input.manual-input").nth(1);
    const deductionInput = row.locator("input.manual-input").nth(2);

    await fillAndSave(page, reportInput, "100");
    await fillAndSave(page, bonusInput, "20");
    await fillAndSave(page, deductionInput, "10");

    // Verify total is at least 110 (may include event and energy scores).
    await expect.poll(
      async () => Number(await totalCell.textContent()),
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(110);

    // Clean up all manual scores
    for (const input of [reportInput, bonusInput, deductionInput]) {
      await fillAndSave(page, input, "");
    }
  });
});
