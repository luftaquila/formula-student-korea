import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();

test.describe("Traffic record export", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed records for export
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Export",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 6789,
          detail: "export test",
        },
      },
    });

    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Export",
        data: {
          time: new Date().toISOString(),
          type: "스키드패드",
          entry: await trafficEntry(2),
          result: 15432,
          detail: "export test skidpad",
        },
      },
    });

    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    // Select the seeded file
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Export`);

    // Wait for table to render
    await expect(page.locator(".data-table")).toBeVisible({ timeout: 5000 });
  });

  test("exports records as CSV", async ({ page }) => {
    // Set up download listener
    const downloadPromise = page.waitForEvent("download");

    // Click CSV download button
    const csvBtn = page.locator("button.btn-secondary", { hasText: "CSV" });
    await expect(csvBtn).toBeVisible();
    await csvBtn.click();

    // Verify download was triggered
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("E2E-Export");
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test("exports records as XLSX", async ({ page }) => {
    // Set up download listener
    const downloadPromise = page.waitForEvent("download");

    // Click XLSX download button
    const xlsxBtn = page.locator("button.btn-secondary", { hasText: "XLSX" });
    await expect(xlsxBtn).toBeVisible();
    await xlsxBtn.click();

    // Verify download was triggered
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("E2E-Export");
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  // Clean up
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} E2E-Export`);
    await context.close();
  });
});
