import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, dismissNotifications } from "../helpers/utils.mjs";

test.describe("Acceleration manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/accel");
    await waitForPageReady(page);
  });

  test("enables manual mode and measures a record", async ({ page }) => {
    // Enable manual mode
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await expect(manualToggle).toBeVisible();
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    // Set event name
    const eventNameInput = page.locator('.form-input[type="text"]');
    await eventNameInput.fill("E2E-Test");

    // Select team 1
    const teamSelect = page.locator("select.form-input");
    await teamSelect.selectOption("1");

    // Click green light
    const greenBtn = page.locator("button.btn-success", { hasText: "녹색등" });
    await greenBtn.click();

    // Manual sensor buttons should appear
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await expect(sensor1).toBeVisible();
    await expect(sensor2).toBeVisible();

    // Click sensor 1 (start)
    await sensor1.click();
    await page.waitForTimeout(500);

    // Click sensor 2 (finish)
    await sensor2.click();

    // Verify record appears with time display
    const savedSection = page.locator(".saved-section");
    await expect(savedSection).toBeVisible({ timeout: 5000 });
    await expect(savedSection).toContainText("측정 기록");

    // Verify saved notification
    await expectNotification(page, "success", "기록 저장");
  });

  test("records DNF when DNF button is clicked", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name and select team
    await page.locator('.form-input[type="text"]').fill("E2E-DNF");
    await page.locator("select.form-input").selectOption("2");

    // Click green light to enable DNF button
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    // Click DNF button
    const dnfBtn = page.locator("button.btn-danger.btn-block", { hasText: "DNF" });
    await expect(dnfBtn).toBeEnabled();
    await dnfBtn.click();

    // Verify DNF notification
    await expectNotification(page, "success", "DNF 기록 저장");
  });

  test("resets and re-measures after reset", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name and select team
    await page.locator('.form-input[type="text"]').fill("E2E-Reset");
    await page.locator("select.form-input").selectOption("3");

    // First measurement
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await sensor1.click();
    await page.waitForTimeout(500);
    await sensor2.click();

    // Wait for record to appear
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await dismissNotifications(page);

    // Click reset button
    const resetBtn = page.locator("button.btn-warning.btn-block", { hasText: "초기화" });
    await resetBtn.click();

    // Saved section should disappear
    await expect(page.locator(".saved-section")).not.toBeVisible();

    // Re-measure: click green light again
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    await expect(sensor1).toBeVisible();

    await sensor1.click();
    await page.waitForTimeout(500);
    await sensor2.click();

    // Verify new record appears
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expectNotification(page, "success", "기록 저장");
  });
});
