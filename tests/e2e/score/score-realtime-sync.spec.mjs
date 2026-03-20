import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score dashboard real-time sync via SSE", () => {
  // Multi-context tests need extra time for SSE setup in CI
  test.describe.configure({ timeout: 60000 });

  // Clean up after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    try {
      // Reset manual score for team #30 (부산대학교)
      await page.request.put(`/score/api/score/manual`, {
        data: { year: YEAR, team_num: 30, score_type: "report", value: null },
      });
      // Reset penalty for endurance
      await page.request.put(`/score/api/score/penalty`, {
        data: { year: YEAR, event_type: "내구", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
      });
      // Reset setting for endurance
      await page.request.put(`/score/api/score/setting`, {
        data: { year: YEAR, event_type: "내구", setting_key: "total", value: null },
      });
    } catch { /* ignore */ }
    await context.close();
  });

  test("manual score edit propagates to second context via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/score/events"));

    await page1.goto("/score");
    await page2.goto("/score");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // In context 1: enter report score for team #30 (부산대학교)
    const table1 = page1.locator("table.score-table");
    const row1 = table1.locator("tbody tr.team-row").filter({ hasText: "부산대학교" });
    await expect(row1).toBeVisible();

    // Read current value to pick a different one (avoids no-op save if previous cleanup failed)
    const reportInput1 = row1.locator("input.manual-input").nth(0);
    const currentVal = await reportInput1.inputValue();
    const newValue = Number(currentVal) === 75 ? "80" : "75";

    const savePromise = page1.waitForResponse((res) => res.url().includes("/api/score/manual") && res.status() === 200);
    // Atomically set value and blur to prevent Vue re-render from overwriting between fill() and blur()
    await reportInput1.evaluate((el, v) => {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    }, newValue);
    await savePromise;

    // Verify context 2 receives the update via SSE
    const table2 = page2.locator("table.score-table");
    const row2 = table2.locator("tbody tr.team-row").filter({ hasText: "부산대학교" });
    const reportInput2 = row2.locator("input.manual-input").nth(0);
    await expect(reportInput2).toHaveValue(newValue, { timeout: 10000 });

    // Cleanup: reset to empty
    const cleanupPromise = page1.waitForResponse((res) => res.url().includes("/api/score/manual") && res.status() === 200);
    await reportInput1.evaluate((el) => {
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    });
    await Promise.race([cleanupPromise, page1.waitForTimeout(2000)]);

    await context1.close();
    await context2.close();
  });

  test("penalty setting change propagates via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/score/events"));

    await page1.goto("/score");
    await page2.goto("/score");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Wait for bottom-row to be visible (events loaded)
    const bottomRow1 = page1.locator(".bottom-row");
    await expect(bottomRow1).toBeVisible({ timeout: 5000 });

    // In context 1: change endurance cone_penalty to a new value
    const penaltyTable1 = page1.locator(".setting-card").first().locator("table.setting-table");
    const coneRow1 = penaltyTable1.locator("tr").filter({ hasText: "콘터치" });
    const coneCells1 = coneRow1.locator("td.setting-cell");
    const lastConeCell1 = coneCells1.last();

    // Read current value before editing to pick a different one (avoids no-op save if previous cleanup failed)
    const currentText = await lastConeCell1.locator(".setting-text").textContent();
    const currentValue = Number(currentText) || 0;
    const newValue = currentValue === 3 ? 5 : 3;

    await lastConeCell1.click();
    const input1 = lastConeCell1.locator("input.setting-input");
    await expect(input1).toBeVisible({ timeout: 3000 });

    const penaltySavePromise = page1.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    // Atomically set value and blur to prevent Vue re-render/SSE from closing edit mode
    await input1.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    }, String(newValue));
    await penaltySavePromise;

    // Verify context 2 receives the penalty update via SSE
    const bottomRow2 = page2.locator(".bottom-row");
    await expect(bottomRow2).toBeVisible({ timeout: 5000 });
    const penaltyTable2 = page2.locator(".setting-card").first().locator("table.setting-table");
    const coneRow2 = penaltyTable2.locator("tr").filter({ hasText: "콘터치" });
    const lastConeCell2 = coneRow2.locator("td.setting-cell").last();
    await expect(lastConeCell2.locator(".setting-text")).toHaveText(String(newValue), { timeout: 10000 });

    // Cleanup: reset to 0
    await lastConeCell1.click();
    const resetInput = lastConeCell1.locator("input.setting-input");
    await expect(resetInput).toBeVisible({ timeout: 3000 });
    const cleanupPenalty = page1.waitForResponse((res) => res.url().includes("/api/score/penalty") && res.status() === 200);
    await resetInput.fill("0");
    await resetInput.blur();
    await Promise.race([cleanupPenalty, page1.waitForTimeout(2000)]);

    await context1.close();
    await context2.close();
  });

  test("score setting change propagates via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/score/events"));

    await page1.goto("/score");
    await page2.goto("/score");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Wait for bottom-row
    const bottomRow1 = page1.locator(".bottom-row");
    await expect(bottomRow1).toBeVisible({ timeout: 5000 });

    // In context 1: change endurance total setting
    const scoreTable1 = page1.locator(".setting-card").nth(1).locator("table.setting-table");
    const totalRow1 = scoreTable1.locator("tr").filter({ hasText: "총점" });
    const lastTotalCell1 = totalRow1.locator("td.setting-cell").last();

    // Read current value before editing to pick a different one (avoids no-op save if previous cleanup failed)
    const currentText = await lastTotalCell1.locator(".setting-text").textContent();
    const currentValue = Number(currentText) || 0;
    const newValue = currentValue === 300 ? 500 : 300;

    await lastTotalCell1.click();
    const input1 = lastTotalCell1.locator("input.setting-input");
    await expect(input1).toBeVisible({ timeout: 3000 });

    const settingSavePromise = page1.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await input1.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    }, String(newValue));
    await settingSavePromise;

    // Verify context 2 receives the setting update via SSE
    const bottomRow2 = page2.locator(".bottom-row");
    await expect(bottomRow2).toBeVisible({ timeout: 5000 });
    const scoreTable2 = page2.locator(".setting-card").nth(1).locator("table.setting-table");
    const totalRow2 = scoreTable2.locator("tr").filter({ hasText: "총점" });
    const lastTotalCell2 = totalRow2.locator("td.setting-cell").last();
    await expect(lastTotalCell2.locator(".setting-text")).toHaveText(String(newValue), { timeout: 10000 });

    // Cleanup: reset to empty
    await lastTotalCell1.click();
    const resetInput = lastTotalCell1.locator("input.setting-input");
    await expect(resetInput).toBeVisible({ timeout: 3000 });
    const cleanupSetting = page1.waitForResponse((res) => res.url().includes("/api/score/setting") && res.status() === 200);
    await resetInput.fill("");
    await resetInput.blur();
    await Promise.race([cleanupSetting, page1.waitForTimeout(2000)]);

    await context1.close();
    await context2.close();
  });
});
