import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

async function fillAndSave(page, input, value) {
  const saved = page.waitForResponse(
    (res) => res.url().includes("/api/score/endurance") && res.request().method() === "PUT" && res.status() === 200,
  );
  await input.click();
  await input.fill(value);
  await input.blur();
  await saved;
}

test.describe("Score endurance real-time sync via SSE", () => {
  test.describe.configure({ timeout: 60000 });

  // Clean up team #32 endurance data after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    try {
      // Clear all fields we may have set for team #32 (중앙대학교, entry num 32)
      for (const field of ["driver1_time", "driver1_cones"]) {
        await page.request.put(`/score/api/score/endurance`, {
          data: { year: YEAR, team_num: 32, field, value: null },
        });
      }
    } catch { /* ignore */ }
    await context.close();
  });

  test("endurance field edit propagates to second context via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/score/events"));

    await page1.goto("/score/endurance");
    await page2.goto("/score/endurance");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Find the row for team #32 (중앙대학교) in context 1
    const table1 = page1.locator("table.endurance-table");
    const row1 = table1.locator("tbody tr").filter({ hasText: "중앙대학교" });
    await expect(row1).toBeVisible();

    // Pick a value different from current to guarantee a save fires
    const driver1Time1 = row1.locator("input.time-input").nth(0);
    const currentTime = await driver1Time1.inputValue();
    const isFirstValue = currentTime === "" || currentTime === "01:00.000";
    const newTime = isFirstValue ? "2:00.000" : "1:00.000";
    const expectedTime = isFirstValue ? "02:00.000" : "01:00.000";

    await fillAndSave(page1, driver1Time1, newTime);

    // Verify the value appears in context 2 via SSE
    const table2 = page2.locator("table.endurance-table");
    const row2 = table2.locator("tbody tr").filter({ hasText: "중앙대학교" });
    const driver1Time2 = row2.locator("input.time-input").nth(0);
    await expect(driver1Time2).toHaveValue(expectedTime, { timeout: 15000 });

    // Cleanup is not a second UI-save assertion. Use the API so client-side
    // SSE reconciliation cannot turn it into a no-op with no response.
    const cleanup = await page1.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: 32, field: "driver1_time", value: null },
    });
    expect(cleanup.ok()).toBeTruthy();

    await context1.close();
    await context2.close();
  });

  test("deferred update when editing same cell concurrently", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/score/events"));

    await page1.goto("/score/endurance");
    await page2.goto("/score/endurance");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Pre-set driver1_cones = 3 for team #32 via API so we have a known starting value
    await page1.request.put(`/score/api/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_cones", value: 3 },
    });

    // Wait for SSE to propagate to both contexts
    const table2 = page2.locator("table.endurance-table");
    const row2 = table2.locator("tbody tr").filter({ hasText: "중앙대학교" });
    const conesInput2 = row2.locator("input.num-input").nth(1); // driver1_cones
    await expect(conesInput2).toHaveValue("3", { timeout: 10000 });

    // In context 2: focus on driver1_cones (triggers focusedCell) but do NOT type
    await conesInput2.click();
    await expect(conesInput2).toBeFocused();

    // From context 1: set driver1_cones = 9 via API (SSE will be deferred in context 2)
    await page1.request.put(`/score/api/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_cones", value: 9 },
    });

    // Wait for SSE to arrive in context 2
    await page2.waitForTimeout(2000);

    // Context 2's focused input should still show "3" (deferred, not updated to 9)
    await expect(conesInput2).toHaveValue("3");

    // Blur in context 2 to apply deferred update
    await conesInput2.blur();

    // After blur, the deferred SSE value (9) should apply since user didn't edit
    await expect(conesInput2).toHaveValue("9", { timeout: 5000 });

    // Cleanup: clear value
    await page1.request.put(`/score/api/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_cones", value: null },
    });

    await context1.close();
    await context2.close();
  });
});
