import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, dismissNotifications } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Acceleration manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    for (const name of ["E2E-Test", "E2E-DNF", "E2E-Reset"]) {
      await page.request.delete(`/traffic/api/records/FSK ${YEAR} ${name}`);
    }
    await context.close();
  });

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

    // 방금 저장된 행을 화면 이동 없이 편집할 수 있다.
    const quickEdit = page.getByTestId("record-quick-edit");
    await expect(quickEdit).toBeVisible();
    await expect(savedSection.getByTestId("record-quick-edit")).toBeVisible();
    await expect(quickEdit).not.toContainText("변경 즉시 저장");
    await expect(page.getByTestId("quick-save-status")).not.toBeVisible();

    await page.getByTestId("quick-cones-plus").click();
    await expect(page.getByTestId("quick-cones")).toHaveValue("1");
    await expect(quickEdit.locator(".quick-edit-summary").getByTestId("quick-save-status")).toHaveText("저장됨");

    await page.getByTestId("quick-oc").fill("2");
    await page.getByTestId("quick-oc").blur();
    await expect(page.getByTestId("quick-oc")).toHaveValue("2");

    const scoreboard = page.getByTestId("quick-scoreboard");
    await scoreboard.click();
    await expect(scoreboard).toContainText("숨김");

    const invalidated = page.getByTestId("quick-invalidated");
    let releaseInvalidation;
    let confirmInvalidationContinued;
    const invalidationHeld = new Promise((resolve) => { releaseInvalidation = resolve; });
    const invalidationContinued = new Promise((resolve) => { confirmInvalidationContinued = resolve; });
    const holdInvalidation = async (route) => {
      const data = route.request().postDataJSON();
      if (route.request().method() === "PATCH" && data?.field === "invalidated") {
        await invalidationHeld;
      }
      await route.continue();
      if (data?.field === "invalidated") confirmInvalidationContinued();
    };
    await page.route("**/traffic/api/records/**", holdInvalidation);
    await invalidated.click();
    await expect(invalidated).toBeDisabled();
    await expect(scoreboard).toBeDisabled();
    releaseInvalidation();
    await invalidationContinued;
    await page.unroute("**/traffic/api/records/**", holdInvalidation);
    await expect(invalidated).toContainText("무효");
    await expect(scoreboard).toBeDisabled();

    // 유효화 시 기존 서버 규칙대로 전광판 표시도 함께 복구된다.
    await invalidated.click();
    await expect(invalidated).toContainText("유효");
    await expect(scoreboard).toContainText("표시");
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
    await expect(page.getByTestId("record-quick-edit")).toBeVisible();
    await dismissNotifications(page);

    // Click reset button
    const resetBtn = page.locator("button.btn-warning.btn-block", { hasText: "초기화" });
    await resetBtn.click();

    // Saved section should disappear
    await expect(page.locator(".saved-section")).not.toBeVisible();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();

    // Re-measure: click green light again
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    await expect(sensor1).toBeVisible();

    await sensor1.click();
    await page.waitForTimeout(500);
    await sensor2.click();

    // Verify new record appears
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("record-quick-edit")).toBeVisible();
    await expectNotification(page, "success", "기록 저장");
  });

  test("hides post-processing on OFF and shows it for the next record", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await page.locator('.form-input[type="text"]').fill("E2E-Reset");
    await page.locator("select.form-input").selectOption("3");

    const green = page.locator("button.btn-success", { hasText: "녹색등" });
    const off = page.locator("button.btn-ghost", { hasText: "OFF" });
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");

    await green.click();
    await sensor1.click();
    await page.waitForTimeout(400);
    await sensor2.click();
    await expect(page.getByTestId("record-quick-edit")).toBeVisible({ timeout: 5000 });

    await off.click();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();

    await green.click();
    await sensor1.click();
    await page.waitForTimeout(400);
    await sensor2.click();
    await expect(page.getByTestId("record-quick-edit")).toBeVisible({ timeout: 5000 });
  });
});
