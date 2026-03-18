import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Traffic record export", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed records for export
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Export",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 6789,
          detail: "export test",
        },
      },
    });

    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Export",
        data: {
          time: new Date().toISOString(),
          type: "스키드패드",
          entry: { num: 2, univ: "한양대학교", team: "ACES" },
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
    expect(download.suggestedFilename()).toEndWith(".csv");
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
    expect(download.suggestedFilename()).toEndWith(".xlsx");
  });

  // Clean up
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/traffic/api/records/FSK ${YEAR} E2E-Export`);
    await context.close();
  });
});
