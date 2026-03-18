import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Autocross manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/autocross");
    await waitForPageReady(page);
  });

  test("saves record on second sensor pass", async ({ page }) => {
    // Enable manual mode
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    // Set event name
    await page.locator('.form-input[type="text"]').fill("E2E-Autocross");

    // Select team 10
    await page.locator("select.form-input").selectOption("10");

    // Click green light
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    // Sensor 1 button should appear (autocross uses only sensor 1)
    const sensor1 = page.getByTestId("manual-sensor-1");
    await expect(sensor1).toBeVisible();

    // First pass (ignored for saving, just records delay)
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Second pass -- triggers save
    await sensor1.click();

    // Verify saved notification
    await expectNotification(page, "success", "기록 저장");

    // Verify saved record appears with save indicator
    const teamCard = page.locator(".team-card");
    await expect(teamCard).toBeVisible({ timeout: 5000 });
    await expect(teamCard).toContainText("KAIST");
  });

  test("first pass does not trigger save", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name and team
    await page.locator('.form-input[type="text"]').fill("E2E-Autocross-First");
    await page.locator("select.form-input").selectOption("2");

    // Click green light
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    const sensor1 = page.getByTestId("manual-sensor-1");

    // First pass only
    await sensor1.click();

    // Wait briefly to confirm no save notification appears
    await page.waitForTimeout(500);

    // The record-list should have only 1 record item (first pass), no save indicator
    const recordItems = page.locator(".record-item");
    await expect(recordItems).toHaveCount(1);
    await expect(page.locator(".record-item.is-saved")).toHaveCount(0);
  });
});
