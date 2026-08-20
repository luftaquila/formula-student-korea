import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, enduranceTable } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

async function fillAndSave(page, input, value) {
  await input.click();
  await input.fill(value);
  const confirm = input.locator("xpath=..").locator("button.confirm-input-btn");
  await expect(confirm).toBeVisible();
  const saved = page.waitForResponse(
    (res) => res.url().includes("/competition/api/v1/score/score/endurance") && res.request().method() === "PUT" && res.status() === 200,
  );
  await confirm.click();
  await saved;
  await expect(confirm).toHaveCount(0);
}

test.describe("Score endurance real-time sync via SSE", () => {
  test.describe.configure({ timeout: 60000 });

  // Clean up team #32 endurance data after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    try {
      // Clear all fields we may have set for team #32 (중앙대학교, entry num 32)
      for (const field of ["driver1_time", "driver1_cones", "driver1_oc"]) {
        await page.request.put(`/competition/api/v1/score/score/endurance`, {
          data: { year: YEAR, team_num: 32, field, value: null },
        });
      }
      await page.request.put(`/competition/api/v1/score/score/endurance`, {
        data: { year: YEAR, team_num: 32, field: "qualified", value: 0 },
      });
    } catch { /* ignore */ }
    await context.close();
  });

  test("endurance field edit propagates to second context via SSE", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));

    await page1.goto("/score/endurance");
    await page2.goto("/score/endurance");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Find the row for team #32 (중앙대학교) in context 1
    const table1 = enduranceTable(page1);
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
    const table2 = enduranceTable(page2);
    const row2 = table2.locator("tbody tr").filter({ hasText: "중앙대학교" });
    const driver1Time2 = row2.locator("input.time-input").nth(0);
    await expect(driver1Time2).toHaveValue(expectedTime, { timeout: 15000 });

    // Cleanup is not a second UI-save assertion. Use the API so client-side
    // SSE reconciliation cannot turn it into a no-op with no response.
    const cleanup = await page1.request.put("/competition/api/v1/score/score/endurance", {
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
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));

    await page1.goto("/score/endurance");
    await page2.goto("/score/endurance");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Pre-set driver1_cones = 3 for team #32 via API so we have a known starting value
    await page1.request.put(`/competition/api/v1/score/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_cones", value: 3 },
    });

    // Wait for SSE to propagate to both contexts
    const table2 = enduranceTable(page2);
    const row2 = table2.locator("tbody tr").filter({ hasText: "중앙대학교" });
    const conesInput2 = row2.locator("input.num-input").nth(1); // driver1_cones
    await expect(conesInput2).toHaveValue("3", { timeout: 10000 });

    // In context 2: type an unconfirmed value while the same field changes remotely.
    await conesInput2.click();
    await conesInput2.fill("8");
    await expect(conesInput2).toBeFocused();

    // From context 1: set driver1_cones = 9 via API (SSE will be deferred in context 2)
    await page1.request.put(`/competition/api/v1/score/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_cones", value: 9 },
    });

    // 같은 SSE 스트림에서 뒤따르는 마커 필드가 반영되면 앞선 cones 이벤트도 도착했다.
    const markerInput2 = row2.locator("input.num-input").nth(2);
    await page1.request.put(`/competition/api/v1/score/score/endurance`, {
      data: { year: YEAR, team_num: 32, field: "driver1_oc", value: 47 },
    });
    await expect(markerInput2).toHaveValue("47", { timeout: 10000 });

    // Context 2's unconfirmed input should still show "8" (deferred, not updated to 9)
    await expect(conesInput2).toHaveValue("8");

    // Blur in context 2 to apply deferred update
    await conesInput2.blur();

    // After blur, the unconfirmed edit is discarded and the deferred SSE value applies.
    await expect(conesInput2).toHaveValue("9", { timeout: 5000 });

    // Cleanup: clear values
    for (const field of ["driver1_cones", "driver1_oc"]) {
      await page1.request.put(`/competition/api/v1/score/score/endurance`, {
        data: { year: YEAR, team_num: 32, field, value: null },
      });
    }

    await context1.close();
    await context2.close();
  });

  test("discards an unconfirmed edit when the qualification filter removes its row", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    for (const [field, value] of [["driver1_cones", 4], ["qualified", 1]]) {
      const response = await page.request.put("/competition/api/v1/score/score/endurance", {
        data: { year: YEAR, team_num: 32, field, value },
      });
      expect(response.ok()).toBeTruthy();
    }

    const sse = page.waitForResponse((res) => res.url().includes("/competition/api/v1/score/score/events"));
    await page.goto("/score/endurance");
    await waitForPageReady(page);
    await sse;

    const filter = page.locator("label.filter-checkbox").filter({ hasText: "내구 진출팀" }).locator("input");
    await filter.check();
    const row = enduranceTable(page).locator("tbody tr").filter({ hasText: "중앙대학교" });
    const conesInput = row.locator("input.num-input").nth(1);
    await expect(conesInput).toHaveValue("4");
    await conesInput.click();
    await conesInput.fill("8");
    await expect(conesInput.locator("xpath=..").locator("button.confirm-input-btn")).toBeVisible();

    let response = await page.request.put("/competition/api/v1/score/score/endurance", {
      data: { year: YEAR, team_num: 32, field: "qualified", value: 0 },
    });
    expect(response.ok()).toBeTruthy();
    await expect(row).toHaveCount(0);

    response = await page.request.put("/competition/api/v1/score/score/endurance", {
      data: { year: YEAR, team_num: 32, field: "qualified", value: 1 },
    });
    expect(response.ok()).toBeTruthy();
    await expect(row).toBeVisible();
    await expect(row.locator("input.num-input").nth(1)).toHaveValue("4");
    await expect(row.locator("button.confirm-input-btn")).toHaveCount(0);

    for (const [field, value] of [["driver1_cones", null], ["qualified", 0]]) {
      response = await page.request.put("/competition/api/v1/score/score/endurance", {
        data: { year: YEAR, team_num: 32, field, value },
      });
      expect(response.ok()).toBeTruthy();
    }
    await context.close();
  });
});
