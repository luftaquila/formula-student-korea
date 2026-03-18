import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Skidpad manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/skidpad");
    await waitForPageReady(page);
  });

  test("completes 4-lap measurement and saves record", async ({ page }) => {
    // Enable manual mode
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    // Set event name
    await page.locator('.form-input[type="text"]').fill("E2E-Skidpad");

    // Select team 1
    await page.locator("select.form-input").selectOption("1");

    // Click green light
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    // Manual sensor button should appear (skidpad only has sensor 1)
    const sensor1 = page.getByTestId("manual-sensor-1");
    await expect(sensor1).toBeVisible();

    // Start: first click initializes lastTick (no lap recorded)
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Lap 1: click sensor 1 (after cooldown)
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Lap 2: click sensor 1
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Lap 3: click sensor 1
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Lap 4: click sensor 1 -- this triggers the save
    await sensor1.click();

    // Verify lap times are displayed
    const lapSection = page.locator(".lap-section");
    await expect(lapSection).toBeVisible({ timeout: 5000 });
    await expect(lapSection).toContainText("Lap 1");
    await expect(lapSection).toContainText("Lap 4");

    // Verify total time is displayed
    await expect(lapSection).toContainText("TOTAL");

    // Verify saved notification (after lap 4)
    await expectNotification(page, "success", "스키드패드 저장");
  });

  test("displays sensor records during measurement", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name (no team selected -- test mode)
    await page.locator('.form-input[type="text"]').fill("E2E-Skidpad-NoTeam");

    // Click green light
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    const sensor1 = page.getByTestId("manual-sensor-1");

    // Trigger a few laps
    await sensor1.click();
    await page.waitForTimeout(1100);
    await sensor1.click();

    // Verify sensor records section appears
    const sensorSection = page.locator(".sensor-section");
    await expect(sensorSection).toBeVisible({ timeout: 5000 });
    await expect(sensorSection).toContainText("센서 기록");
  });
});
