import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, dismissNotifications, setCustomEventName } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

// 오토크로스는 가속과 동일한 출발 센서(1) → 도착 센서(2) 측정 방식(StartFinishView 공용).
test.describe("Autocross manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    for (const name of ["E2E-Autocross", "E2E-Autocross-DNF", "E2E-Autocross-Reset"]) {
      await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${name}`);
    }
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/autocross");
    await waitForPageReady(page);
  });

  test("enables manual mode and measures a record (start → finish)", async ({ page }) => {
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await expect(manualToggle).toBeVisible();
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    await setCustomEventName(page, "E2E-Autocross");
    await page.getByTestId("event-team").selectOption("1");

    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    // 출발/도착 두 센서 버튼 모두 표시(2센서 경기).
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await expect(sensor1).toBeVisible();
    await expect(sensor2).toBeVisible();

    await sensor1.click(); // 출발
    await page.waitForTimeout(500);
    await sensor2.click(); // 도착 → 기록

    const savedSection = page.locator(".saved-section");
    await expect(savedSection).toBeVisible({ timeout: 5000 });
    await expect(savedSection).toContainText("측정 기록");

    await expectNotification(page, "success", "기록 저장");
  });

  test("records DNF when DNF button is clicked", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Autocross-DNF");
    await page.getByTestId("event-team").selectOption("2");

    const dnfBtn = page.locator('.event-status-panel [data-status="DNF"]');
    await expect(dnfBtn).toBeEnabled();
    await dnfBtn.click();

    await expectNotification(page, "success", "DNF 판정을 저장했습니다.");
  });

  test("resets and re-measures after reset", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Autocross-Reset");
    await page.getByTestId("event-team").selectOption("3");

    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await sensor1.click();
    await page.waitForTimeout(500);
    await sensor2.click();

    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await dismissNotifications(page);

    const resetBtn = page.locator("button.btn-warning.btn-block", { hasText: "초기화" });
    await resetBtn.click();

    await expect(page.locator(".saved-section")).not.toBeVisible();

    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    await expect(sensor1).toBeVisible();
    await sensor1.click();
    await page.waitForTimeout(500);
    await sensor2.click();

    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expectNotification(page, "success", "기록 저장");
  });
});
