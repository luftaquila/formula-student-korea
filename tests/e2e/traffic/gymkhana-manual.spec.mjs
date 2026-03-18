import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Gymkhana manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/gymkhana");
    await waitForPageReady(page);
  });

  test("measures both lanes and saves records", async ({ page }) => {
    // Enable manual mode
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    // Set event name
    await page.locator('.form-input[type="text"]').fill("E2E-Gymkhana");

    // Select lane 1 team (team 1) and lane 2 team (team 2)
    const teamSelects = page.locator("select.form-input");
    await teamSelects.nth(0).selectOption("1");
    await teamSelects.nth(1).selectOption("2");

    // Click green light
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    // Both sensor buttons should appear
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await expect(sensor1).toBeVisible();
    await expect(sensor2).toBeVisible();

    // Lane 1: first pass (sensor 1)
    await sensor1.click();
    await page.waitForTimeout(1100);

    // Lane 1: second pass (sensor 1) -- triggers save for lane 1
    await sensor1.click();

    // Verify lane 1 save notification
    await expectNotification(page, "success", "1번 레인 기록 저장");

    await page.waitForTimeout(1100);

    // Lane 2: first pass (sensor 2)
    await sensor2.click();
    await page.waitForTimeout(1100);

    // Lane 2: second pass (sensor 2) -- triggers save for lane 2
    await sensor2.click();

    // Verify lane 2 save notification
    await expectNotification(page, "success", "2번 레인 기록 저장");

    // Verify both lane cards show records
    const laneCards = page.locator(".lane-card");
    await expect(laneCards).toHaveCount(2);
  });

  test("prevents duplicate team selection across lanes", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Select team 1 for lane 1
    const teamSelects = page.locator("select.form-input");
    await teamSelects.nth(0).selectOption("1");

    // Try to select the same team (1) for lane 2
    await teamSelects.nth(1).selectOption("1");

    // Should show error notification about duplicate selection
    await expectNotification(page, "error", "이미 다른 레인에 선택된 팀입니다");

    // Lane 2 card should not be visible (team was reset to null)
    await expect(page.locator(".lanes-section .lane-card")).toHaveCount(1);
  });
});
