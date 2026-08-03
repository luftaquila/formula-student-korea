import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, setCustomEventName } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Simultaneous event measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    for (const name of ["E2E-MultiAccel", "E2E-MultiAutocross"]) {
      await page.request.delete(`/traffic/api/records/FSK ${YEAR} ${name}`);
    }
    await context.close();
  });

  test("two events measure simultaneously without interference", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("admin") });
    const context2 = await browser.newContext({ storageState: storageStatePath("admin") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Context 1: accel page
    await page1.goto("/traffic/accel");
    await waitForPageReady(page1);

    // Context 2: autocross page
    await page2.goto("/traffic/autocross");
    await waitForPageReady(page2);

    // Both enable manual mode
    await page1.getByTestId("manual-mode-toggle").click();
    await expect(page1.getByTestId("manual-mode-toggle")).toContainText("매뉴얼 모드 ON");

    await page2.getByTestId("manual-mode-toggle").click();
    await expect(page2.getByTestId("manual-mode-toggle")).toContainText("매뉴얼 모드 ON");

    // Set event names
    await setCustomEventName(page1, "E2E-MultiAccel");
    await setCustomEventName(page2, "E2E-MultiAutocross");

    // Select different teams
    await page1.getByTestId("event-team").selectOption("1");
    await page2.getByTestId("event-team").selectOption("2");

    // Both click green light
    await page1.locator("button.btn-success", { hasText: "녹색등" }).click();
    await page2.locator("button.btn-success", { hasText: "녹색등" }).click();

    // Accel: sensor1 → sensor2 (2 sensors)
    const accelSensor1 = page1.getByTestId("manual-sensor-1");
    const accelSensor2 = page1.getByTestId("manual-sensor-2");
    await expect(accelSensor1).toBeVisible();
    await accelSensor1.click();
    await page1.waitForTimeout(500);
    await accelSensor2.click();

    // Autocross: sensor1 → sensor2 (가속과 동일한 출발/도착 2센서)
    const autocrossSensor1 = page2.getByTestId("manual-sensor-1");
    const autocrossSensor2 = page2.getByTestId("manual-sensor-2");
    await expect(autocrossSensor1).toBeVisible();
    await autocrossSensor1.click();
    await page2.waitForTimeout(500);
    await autocrossSensor2.click();

    // Both should save successfully
    await expectNotification(page1, "success", "기록 저장");
    await expectNotification(page2, "success", "기록 저장");

    // Verify records exist via API
    const accelRecords = await page1.request.get(`/traffic/api/records/FSK ${YEAR} E2E-MultiAccel`);
    expect(accelRecords.status()).toBe(200);
    const accelData = await accelRecords.json();
    expect(accelData.length).toBeGreaterThanOrEqual(1);
    expect(accelData[0].num).toBe(1);

    const autocrossRecords = await page2.request.get(`/traffic/api/records/FSK ${YEAR} E2E-MultiAutocross`);
    expect(autocrossRecords.status()).toBe(200);
    const autocrossData = await autocrossRecords.json();
    expect(autocrossData.length).toBeGreaterThanOrEqual(1);
    expect(autocrossData[0].num).toBe(2);

    await context1.close();
    await context2.close();
  });
});
