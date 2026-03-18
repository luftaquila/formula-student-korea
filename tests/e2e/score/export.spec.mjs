import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score export", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("CSV export downloads a file from score dashboard", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);

    // Find the CSV export button
    const csvBtn = page.locator(".action-buttons button.action-link").filter({ hasText: "CSV" });
    await expect(csvBtn).toBeVisible();

    // Listen for the download event
    const downloadPromise = page.waitForEvent("download");
    await csvBtn.click();
    const download = await downloadPromise;

    // Verify the downloaded file name contains the year and csv extension
    expect(download.suggestedFilename()).toContain(String(YEAR));
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test("XLSX export downloads a file from score dashboard", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);

    // Find the XLSX export button
    const xlsxBtn = page.locator(".action-buttons button.action-link").filter({ hasText: "XLSX" });
    await expect(xlsxBtn).toBeVisible();

    // Listen for the download event
    const downloadPromise = page.waitForEvent("download");
    await xlsxBtn.click();
    const download = await downloadPromise;

    // Verify the downloaded file name contains the year and xlsx extension
    expect(download.suggestedFilename()).toContain(String(YEAR));
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("CSV export from endurance page downloads a file", async ({ page }) => {
    await page.goto("/score/endurance");
    await waitForPageReady(page);

    // Find the CSV export button on the endurance page
    const csvBtn = page.locator(".action-buttons button.action-link").filter({ hasText: "CSV" });
    await expect(csvBtn).toBeVisible();

    // Listen for the download event
    const downloadPromise = page.waitForEvent("download");
    await csvBtn.click();
    const download = await downloadPromise;

    // Verify the downloaded file name
    expect(download.suggestedFilename()).toContain(String(YEAR));
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test("XLSX export from endurance page downloads a file", async ({ page }) => {
    await page.goto("/score/endurance");
    await waitForPageReady(page);

    // Find the XLSX export button on the endurance page
    const xlsxBtn = page.locator(".action-buttons button.action-link").filter({ hasText: "XLSX" });
    await expect(xlsxBtn).toBeVisible();

    // Listen for the download event
    const downloadPromise = page.waitForEvent("download");
    await xlsxBtn.click();
    const download = await downloadPromise;

    // Verify the downloaded file name
    expect(download.suggestedFilename()).toContain(String(YEAR));
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
