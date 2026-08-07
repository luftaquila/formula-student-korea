import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score penalty and score settings", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
  });

  test("penalty settings table is displayed with event columns", async ({ page }) => {
    // The penalty settings table is in the bottom-row section
    const settingCards = page.locator(".setting-card");

    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    // First setting card: penalty settings
    const penaltyTable = settingCards.first().locator("table.setting-table");
    await expect(penaltyTable).toBeVisible();

    // Verify penalty table header
    await expect(penaltyTable.locator("th").filter({ hasText: "페널티 (초)" })).toBeVisible();
    await expect(penaltyTable.locator("th").filter({ hasText: "내구" })).toBeVisible();

    // Verify penalty row labels
    await expect(penaltyTable.locator("td").filter({ hasText: "콘터치" }).first()).toBeVisible();
    await expect(penaltyTable.locator("td").filter({ hasText: "코스이탈" }).first()).toBeVisible();
    await expect(penaltyTable.locator("td").filter({ hasText: "출발지연" }).first()).toBeVisible();
  });

  test("set cone touch penalty for endurance event", async ({ page }) => {
    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    const penaltyTable = page.locator(".setting-card").first().locator("table.setting-table");

    // Find the cone penalty row
    const coneRow = penaltyTable.locator("tr").filter({ hasText: "콘터치" });
    await expect(coneRow).toBeVisible();

    // Find the endurance column cell (last setting-cell in the row)
    const coneCells = coneRow.locator("td.setting-cell");
    const lastConeCell = coneCells.last();

    // Read current value to pick a different one (avoids no-op save if previous cleanup failed)
    const currentText = await lastConeCell.locator(".setting-text").textContent();
    const currentValue = Number(currentText) || 0;
    const newValue = currentValue === 2 ? 4 : 2;

    // Click to edit and wait for input to appear
    await lastConeCell.click();
    const input = lastConeCell.locator("input.setting-input");
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(input).toBeFocused();

    const savePromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await input.fill(String(newValue));
    await input.blur();
    await savePromise;

    // Verify the value is saved and displayed
    await expect(lastConeCell.locator(".setting-text")).toHaveText(String(newValue));

    // Verify via API that the penalty was saved
    const response = await page.request.get(`/score/api/score?year=${YEAR}`);
    const data = await response.json();
    expect(data.penalties["내구"]?.cone_penalty).toBe(newValue);

    // Clean up: reset to 0
    await lastConeCell.click();
    const resetInput = lastConeCell.locator("input.setting-input");
    await expect(resetInput).toBeVisible({ timeout: 3000 });
    const cleanupPromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await resetInput.fill("0");
    await resetInput.blur();
    await cleanupPromise;
  });

  test("set off-course penalty for endurance event", async ({ page }) => {
    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    const penaltyTable = page.locator(".setting-card").first().locator("table.setting-table");

    // Find the off-course penalty row
    const ocRow = penaltyTable.locator("tr").filter({ hasText: "코스이탈" });
    await expect(ocRow).toBeVisible();

    // Find the endurance column cell (last setting-cell)
    const ocCells = ocRow.locator("td.setting-cell");
    const lastOcCell = ocCells.last();

    // Read current value to pick a different one (avoids no-op save if previous cleanup failed)
    const currentOcText = await lastOcCell.locator(".setting-text").textContent();
    const currentOcValue = Number(currentOcText) || 0;
    const newOcValue = currentOcValue === 10 ? 20 : 10;

    // Click to edit and wait for input to appear
    await lastOcCell.click();
    const input = lastOcCell.locator("input.setting-input");
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(input).toBeFocused();

    const savePromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await input.fill(String(newOcValue));
    await input.blur();
    await savePromise;

    // Verify the value is saved
    await expect(lastOcCell.locator(".setting-text")).toHaveText(String(newOcValue));

    // Verify via API
    const response = await page.request.get(`/score/api/score?year=${YEAR}`);
    const data = await response.json();
    expect(data.penalties["내구"]?.oc_penalty).toBe(newOcValue);

    // Clean up
    await lastOcCell.click();
    const resetInput = lastOcCell.locator("input.setting-input");
    await expect(resetInput).toBeVisible({ timeout: 3000 });
    const cleanupPromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await resetInput.fill("0");
    await resetInput.blur();
    await cleanupPromise;
  });

  test("score settings table renders and set total points for endurance", async ({ page }) => {
    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    // Second setting card: score settings
    const scoreTable = page.locator(".setting-card").nth(1).locator("table.setting-table");
    await expect(scoreTable).toBeVisible();

    // Verify score settings header
    await expect(scoreTable.locator("th").filter({ hasText: "점수" })).toBeVisible();

    // Verify score row labels
    await expect(scoreTable.locator("td").filter({ hasText: "총점" }).first()).toBeVisible();
    await expect(scoreTable.locator("td").filter({ hasText: "완주점수" }).first()).toBeVisible();
    await expect(scoreTable.locator("td").filter({ hasText: "컷오프 (%)" }).first()).toBeVisible();
    await expect(scoreTable.locator("th").filter({ hasText: "보고서" })).toBeVisible();
    await expect(scoreTable.locator("th").filter({ hasText: "에너지" })).toBeVisible();

    // Set total points for endurance by matching the header instead of relying on column order.
    const totalRow = scoreTable.locator("tr").filter({ hasText: "총점" });
    const enduranceColumnIndex = await scoreTable
      .getByRole("columnheader", { name: "내구", exact: true })
      .evaluate((cell) => cell.cellIndex);
    const enduranceTotalCell = totalRow.locator("td").nth(enduranceColumnIndex);

    // Read current value to pick a different one (avoids no-op save if previous cleanup failed)
    const currentText = await enduranceTotalCell.locator(".setting-text").textContent();
    const currentValue = Number(currentText) || 0;
    const newValue = currentValue === 300 ? 500 : 300;

    await enduranceTotalCell.click();
    const input = enduranceTotalCell.locator("input.setting-input");
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(input).toBeFocused();

    // Keep the DOM update and blur in one browser task so an SSE refresh cannot
    // replace the input between the two operations.
    const savePromise = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await input.fill(String(newValue));
    await input.blur();
    await savePromise;

    // Verify the value is saved
    await expect(enduranceTotalCell.locator(".setting-text")).toHaveText(String(newValue));

    // Verify via API
    const response = await page.request.get(`/score/api/score?year=${YEAR}`);
    const data = await response.json();
    expect(data.settings["내구"]?.total).toBe(newValue);

    // Clean up
    await enduranceTotalCell.click();
    const resetInput = enduranceTotalCell.locator("input.setting-input");
    const cleanupPromise = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await resetInput.fill("");
    await resetInput.blur();
    await cleanupPromise;
  });

  test("set completion points and cutoff for endurance", async ({ page }) => {
    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    const scoreTable = page.locator(".setting-card").nth(1).locator("table.setting-table");

    // Set completion points for endurance
    const finishRow = scoreTable.locator("tr").filter({ hasText: "완주점수" });
    const finishCells = finishRow.locator("td.setting-cell");
    const lastFinishCell = finishCells.last();

    const curFinish = Number(await lastFinishCell.locator(".setting-text").textContent()) || 0;
    const newFinish = curFinish === 25 ? 30 : 25;

    await lastFinishCell.click();
    const finishInput = lastFinishCell.locator("input.setting-input");
    const finishSave = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await finishInput.fill(String(newFinish));
    await finishInput.blur();
    await finishSave;
    await expect(lastFinishCell.locator(".setting-text")).toHaveText(String(newFinish));

    // Set cutoff % for endurance
    const cutoffRow = scoreTable.locator("tr").filter({ hasText: "컷오프 (%)" });
    const cutoffCells = cutoffRow.locator("td.setting-cell");
    const lastCutoffCell = cutoffCells.last();

    const curCutoff = Number(await lastCutoffCell.locator(".setting-text").textContent()) || 0;
    const newCutoff = curCutoff === 135 ? 150 : 135;

    await lastCutoffCell.click();
    const cutoffInput = lastCutoffCell.locator("input.setting-input");
    const cutoffSave = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await cutoffInput.fill(String(newCutoff));
    await cutoffInput.blur();
    await cutoffSave;
    await expect(lastCutoffCell.locator(".setting-text")).toHaveText(String(newCutoff));

    // Verify via API
    const response = await page.request.get(`/score/api/score?year=${YEAR}`);
    const data = await response.json();
    expect(data.settings["내구"]?.finish).toBe(newFinish);
    expect(data.settings["내구"]?.cutoff).toBe(newCutoff);

    // Clean up
    await lastFinishCell.click();
    const cleanupFinish = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await lastFinishCell.locator("input.setting-input").fill("");
    await lastFinishCell.locator("input.setting-input").blur();
    await cleanupFinish;

    await lastCutoffCell.click();
    const cleanupCutoff = page.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await lastCutoffCell.locator("input.setting-input").fill("");
    await lastCutoffCell.locator("input.setting-input").blur();
    await cleanupCutoff;
  });

  test("set start delay penalty for endurance event", async ({ page }) => {
    const bottomRow = page.locator(".bottom-row");
    await expect(bottomRow).toBeVisible();

    const penaltyTable = page.locator(".setting-card").first().locator("table.setting-table");

    // Find the start delay penalty row
    const delayRow = penaltyTable.locator("tr").filter({ hasText: "출발지연" });
    await expect(delayRow).toBeVisible();

    // Find the endurance column cell (last setting-cell)
    const delayCells = delayRow.locator("td.setting-cell");
    const lastDelayCell = delayCells.last();

    // Read current value to pick a different one
    const curDelay = Number(await lastDelayCell.locator(".setting-text").textContent()) || 0;
    const newDelay = curDelay === 5 ? 8 : 5;

    // Click to edit
    await lastDelayCell.click();
    const input = lastDelayCell.locator("input.setting-input");
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(input).toBeFocused();

    const savePromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await input.fill(String(newDelay));
    await input.blur();
    await savePromise;

    // Verify the value is saved
    await expect(lastDelayCell.locator(".setting-text")).toHaveText(String(newDelay));

    // Verify via API
    const response = await page.request.get(`/score/api/score?year=${YEAR}`);
    const data = await response.json();
    expect(data.penalties["내구"]?.start_delay).toBe(newDelay);

    // Clean up: reset to 0
    await lastDelayCell.click();
    const resetInput = lastDelayCell.locator("input.setting-input");
    const cleanupPromise = page.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await resetInput.fill("0");
    await resetInput.blur();
    await cleanupPromise;
  });
});
