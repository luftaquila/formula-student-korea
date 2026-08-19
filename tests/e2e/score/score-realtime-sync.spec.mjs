import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Score dashboard real-time sync via SSE", () => {
  // Multi-context tests need extra time for SSE setup in CI
  test.describe.configure({ timeout: 60000 });

  // Clean up after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    try {
      // Reset manual score for team #30 (부산대학교)
      await page.request.put(`/competition/api/v1/score/score/manual`, {
        data: { year: YEAR, team_num: 30, score_type: "report", value: null },
      });
      // Reset the dedicated skidpad penalty used by the SSE test.
      await page.request.put(`/competition/api/v1/score/score/penalty`, {
        data: { year: YEAR, event_type: "스키드패드", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
      });
      // Reset the dedicated energy setting used by the SSE test.
      await page.request.put(`/competition/api/v1/score/score/setting`, {
        data: { year: YEAR, event_type: "에너지", setting_key: "total", value: null },
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
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));

    await page1.goto("/score");
    await page2.goto("/score");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // In context 1: enter report score for team #30 (부산대학교)
    const table1 = scoreTable(page1);
    const row1 = table1.locator("tbody tr.team-row").filter({ hasText: "부산대학교" });
    await expect(row1).toBeVisible();

    // Read current value to pick a different one (avoids no-op save if previous cleanup failed)
    const reportInput1 = row1.locator("input.manual-input").nth(0);
    const currentVal = await reportInput1.inputValue();
    const newValue = Number(currentVal) === 75 ? "80" : "75";

    const savePromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/manual") && res.status() === 200);
    await reportInput1.click();
    await reportInput1.fill(newValue);
    await reportInput1.blur();
    await savePromise;

    // Verify context 2 receives the update via SSE
    const table2 = scoreTable(page2);
    const row2 = table2.locator("tbody tr.team-row").filter({ hasText: "부산대학교" });
    const reportInput2 = row2.locator("input.manual-input").nth(0);
    await expect(reportInput2).toHaveValue(newValue, { timeout: 10000 });

    // Cleanup: reset to empty
    const cleanupPromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/manual") && res.status() === 200);
    await reportInput1.fill("");
    await reportInput1.blur();
    await cleanupPromise;

    await context1.close();
    await context2.close();
  });

  test("penalty setting change propagates via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    try {
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();

      const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
      const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));

      await page1.goto("/score");
      await page2.goto("/score");

      await waitForPageReady(page1);
      await waitForPageReady(page2);
      await sse1;
      await sse2;

      // Wait for bottom-row to be visible (events loaded)
      const bottomRow1 = page1.locator(".bottom-row");
      await expect(bottomRow1).toBeVisible({ timeout: 5000 });

      // Use skidpad so this test does not race the endurance penalty settings
      // exercised by penalty-settings.spec.mjs in another worker.
      const penaltyTable1 = page1.locator(".setting-card").first().locator("table.setting-table");
      const coneRow1 = penaltyTable1.locator("tr").filter({ hasText: "콘터치" });
      const skidpadColumnIndex = await penaltyTable1
        .getByRole("columnheader", { name: "스키드패드", exact: true })
        .evaluate((cell) => cell.cellIndex);
      const skidpadConeCell1 = coneRow1.locator("td").nth(skidpadColumnIndex);

      // Read current value before editing to pick a different one (avoids no-op save if previous cleanup failed)
      const currentText = await skidpadConeCell1.locator(".setting-text").textContent();
      const currentValue = Number(currentText) || 0;
      const newValue = currentValue === 3 ? 5 : 3;

      await skidpadConeCell1.click();
      const input1 = skidpadConeCell1.locator("input.setting-input");
      await expect(input1).toBeVisible({ timeout: 3000 });

      const penaltySavePromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/penalty") && res.status() === 200);
      await input1.fill(String(newValue));
      await input1.blur();
      await penaltySavePromise;

      // Verify context 2 receives the penalty update via SSE
      const bottomRow2 = page2.locator(".bottom-row");
      await expect(bottomRow2).toBeVisible({ timeout: 5000 });
      const penaltyTable2 = page2.locator(".setting-card").first().locator("table.setting-table");
      const coneRow2 = penaltyTable2.locator("tr").filter({ hasText: "콘터치" });
      const skidpadConeCell2 = coneRow2.locator("td").nth(skidpadColumnIndex);
      await expect(skidpadConeCell2.locator(".setting-text")).toHaveText(String(newValue), { timeout: 10000 });
    } finally {
      try {
        // Cleanup is not part of the UI behavior under test. Restore through
        // the authenticated API so an SSE re-render cannot suppress the save.
        const reset = await context1.request.put("/competition/api/v1/score/score/penalty", {
          data: {
            year: YEAR,
            event_type: "스키드패드",
            cone_penalty: 0,
            oc_penalty: 0,
            start_delay: 0,
          },
        });
        expect(reset.ok()).toBeTruthy();
      } finally {
        await Promise.all([context1.close(), context2.close()]);
      }
    }
  });

  test("score setting change propagates via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));

    await page1.goto("/score");
    await page2.goto("/score");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Wait for bottom-row
    const bottomRow1 = page1.locator(".bottom-row");
    await expect(bottomRow1).toBeVisible({ timeout: 5000 });

    // Use the energy total setting so this test does not race the endurance
    // settings exercised by penalty-settings.spec.mjs in another worker.
    const scoreTable1 = page1.locator(".setting-card").nth(1).locator("table.setting-table");
    const totalRow1 = scoreTable1.locator("tr").filter({ hasText: "총점" });
    const energyColumnIndex = await scoreTable1
      .getByRole("columnheader", { name: "에너지", exact: true })
      .evaluate((cell) => cell.cellIndex);
    const energyTotalCell1 = totalRow1.locator("td").nth(energyColumnIndex);

    // Read current value before editing to pick a different one (avoids no-op save if previous cleanup failed)
    const currentText = await energyTotalCell1.locator(".setting-text").textContent();
    const currentValue = Number(currentText) || 0;
    const newValue = currentValue === 300 ? 500 : 300;

    await energyTotalCell1.click();
    const input1 = energyTotalCell1.locator("input.setting-input");
    await expect(input1).toBeVisible({ timeout: 3000 });

    const settingSavePromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/setting") && res.status() === 200);
    await input1.fill(String(newValue));
    await input1.blur();
    await settingSavePromise;

    // Verify context 2 receives the setting update via SSE
    const bottomRow2 = page2.locator(".bottom-row");
    await expect(bottomRow2).toBeVisible({ timeout: 5000 });
    const scoreTable2 = page2.locator(".setting-card").nth(1).locator("table.setting-table");
    const totalRow2 = scoreTable2.locator("tr").filter({ hasText: "총점" });
    const energyTotalCell2 = totalRow2.locator("td").nth(energyColumnIndex);
    await expect(energyTotalCell2.locator(".setting-text")).toHaveText(String(newValue), { timeout: 10000 });

    // Cleanup: reset to empty
    await energyTotalCell1.click();
    const resetInput = energyTotalCell1.locator("input.setting-input");
    await expect(resetInput).toBeVisible({ timeout: 3000 });
    const cleanupSetting = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/setting") && res.status() === 200);
    await resetInput.fill("");
    await resetInput.blur();
    await cleanupSetting;

    await context1.close();
    await context2.close();
  });
});
