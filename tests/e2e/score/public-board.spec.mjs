import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { expectCompactTeamIdentity, storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

async function setPublication(browser, enabled) {
  const context = await browser.newContext({ storageState: storageStatePath("admin") });
  const page = await context.newPage();
  const res = await page.request.put("/competition/api/v1/score/score/publication", { data: { year: YEAR, enabled } });
  expect(res.ok()).toBe(true);
  await context.close();
}

test.describe("Public score board", () => {
  test.beforeAll(async ({ browser }) => {
    await setPublication(browser, true);
  });

  test.afterAll(async ({ browser }) => {
    await setPublication(browser, false);
  });

  test("uses the compact mobile identity column and persistent type filters", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await page.goto(`/score/public/${YEAR}`);
    await waitForPageReady(page);

    const table = scoreTable(page);
    const firstRow = table.locator("tbody tr").first();
    await expect(table.locator("thead .col-num")).toContainText("엔트리");
    await expect(firstRow.locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-name")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-type")).toBeVisible();
    await expect(firstRow.locator("td.col-team")).toBeHidden();
    await expect(firstRow.locator("td.col-type")).toBeHidden();
    await expectCompactTeamIdentity(table);

    const cv = page.getByTestId("public-score-type-filter").locator("label", { hasText: "CV" }).locator("input");
    await cv.uncheck();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("score-public-type-filter"))).toContain('"CV":false');
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("public-score-type-filter").locator("label", { hasText: "CV" }).locator("input")).not.toBeChecked();
  });
});
