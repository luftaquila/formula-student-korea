import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, setCustomEventName } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const EVENT = "E2E-Endurance-Quick-Edit";

test.describe("Endurance manual mode post-processing", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${EVENT}`).catch(() => {});
    await context.close();
  });

  test("shows the editor after the first saved lap and clears it on reset", async ({ page }) => {
    await page.goto("/traffic/endurance");
    await waitForPageReady(page);

    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, EVENT);
    await page.getByTestId("event-team").selectOption("1");
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();

    const sensor = page.getByTestId("manual-sensor-1");
    await sensor.click(); // 출발선 t0
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();
    await page.waitForTimeout(400);
    await sensor.click(); // 첫 랩 저장

    await expect(page.locator(".lap-section").getByTestId("record-quick-edit")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("quick-oc-plus").click();
    await expect(page.getByTestId("quick-oc")).toHaveValue("1");

    await page.locator("button.btn-warning", { hasText: "초기화" }).click();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();
  });
});
