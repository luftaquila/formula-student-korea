import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import {
  expectSSEEventAfter,
  installSSEEventProbe,
  storageStatePath,
  waitForPageReady,
} from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `e2e-concurrent`;
const FULL_TABLE_NAME = `FSK ${YEAR} ${TABLE_NAME}`;

test.describe("Traffic record concurrent edit guard", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed dedicated record table with 2 records
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create first record
    const res1 = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: TABLE_NAME,
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 4000,
          detail: "concurrent test 1",
        },
      },
    });
    expect(res1.status()).toBe(201);

    // Create second record
    const res2 = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: TABLE_NAME,
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(2),
          result: 5000,
          detail: "concurrent test 2",
        },
      },
    });
    expect(res2.status()).toBe(201);

    await context.close();
  });

  // Clean up: delete the record table
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    try {
      await page.request.delete(`/competition/api/v1/traffic/records/${FULL_TABLE_NAME}`);
    } catch { /* ignore */ }
    await context.close();
  });

  test("SSE update deferred while inline editing same record", async ({ page }) => {
    await installSSEEventProbe(page, ["records"]);
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    // Select the test record table
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(FULL_TABLE_NAME);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Verify both records are present
    await expect(table.locator("tbody tr")).toHaveCount(2);

    // Get the rows (sorted by time desc by default, so first created = last row)
    // Sort by time ascending so record 1 is first
    const timeHeader = table.locator("th.sortable").first();
    await timeHeader.click(); // first click = asc

    const firstRow = table.locator("tbody tr").first();
    await expect(firstRow).toContainText("서울대학교");

    // Record the initial OC value
    const ocCell = firstRow.locator(".penalty-cell").nth(1);
    const initialOcText = await ocCell.locator(".penalty-text").textContent();

    // Focus on cones input for record 1 (triggers editingConesId)
    const conesCell = firstRow.locator(".penalty-cell").first();
    await conesCell.click();
    const conesInput = conesCell.locator(".penalty-input");
    await expect(conesInput).toBeVisible();

    // Get the rowid of the first record via API
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${FULL_TABLE_NAME}`);
    const records = await recordsRes.json();
    // Find record for team #1
    const record1 = records.find((r) => r.num === 1);

    // API: PATCH OC field on record 1 while cones input is focused
    await expectSSEEventAfter(page, "records", () => page.request.patch(
      `/competition/api/v1/traffic/records/${FULL_TABLE_NAME}/${record1.rowid}`,
      { data: { field: "oc", value: "7" } },
    ));

    // OC cell should still show old value (isEditingRow guard defers the update)
    await expect(ocCell.locator(".penalty-text")).toHaveText(initialOcText);

    // Blur cones input to release the edit guard
    await conesInput.blur();

    // After blur, missedUpdate triggers refreshRecords — OC should update
    await expect(ocCell.locator(".penalty-text")).toHaveText("7", { timeout: 5000 });
  });

  test("SSE update applies immediately for different record", async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    // Select the test record table
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(FULL_TABLE_NAME);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Sort by time ascending
    const timeHeader = table.locator("th.sortable").first();
    await timeHeader.click();

    const firstRow = table.locator("tbody tr").first();
    const secondRow = table.locator("tbody tr").nth(1);
    await expect(firstRow).toContainText("서울대학교");
    await expect(secondRow).toContainText("한양대학교");

    // Focus on record 1's cones input
    const conesCell = firstRow.locator(".penalty-cell").first();
    await conesCell.click();
    const conesInput = conesCell.locator(".penalty-input");
    await expect(conesInput).toBeVisible();

    // Get the rowid of the second record via API
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${FULL_TABLE_NAME}`);
    const records = await recordsRes.json();
    const record2 = records.find((r) => r.num === 2);

    // API: PATCH OC field on record 2 (different record)
    await page.request.patch(`/competition/api/v1/traffic/records/${FULL_TABLE_NAME}/${record2.rowid}`, {
      data: { field: "oc", value: "4" },
    });

    // Record 2's OC cell should update immediately (no guard for different row)
    const ocCell2 = secondRow.locator(".penalty-cell").nth(1);
    await expect(ocCell2.locator(".penalty-text")).toHaveText("4", { timeout: 5000 });

    // Clean up
    await conesInput.blur();
  });
});
