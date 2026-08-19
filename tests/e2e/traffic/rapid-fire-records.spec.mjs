import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-RapidFire`;

test.describe("Rapid successive record creation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create 5 records in quick succession (no delays)
    const teams = await Promise.all([1, 2, 3, 10, 20].map((number) => trafficEntry(number)));

    const promises = teams.map((entry, i) =>
      page.request.post("/competition/api/v1/traffic/records", {
        data: {
          name: "E2E-RapidFire",
          data: {
            time: new Date(Date.now() + i).toISOString(),
            type: "가속",
            entry,
            result: 5000 + i * 1000,
            detail: `rapid fire record ${i + 1}`,
          },
        },
      }),
    );

    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.status()).toBe(201);
    }

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    await context.close();
  });

  test("all 5 rapidly created records render in record table", async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    // Select the record file
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(TABLE_NAME);

    // Wait for table to render
    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Verify all 5 rows exist
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(5);

    // Verify each team appears
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
    await expect(table.locator("tbody")).toContainText("성균관대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");
    await expect(table.locator("tbody")).toContainText("고려대학교");
  });

  test("all 5 records have correct data via API", async ({ page }) => {
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    expect(records.length).toBe(5);

    // Verify each record's result
    const results = records.map((r) => r.result).sort((a, b) => a - b);
    expect(results).toEqual([5000, 6000, 7000, 8000, 9000]);
  });
});
