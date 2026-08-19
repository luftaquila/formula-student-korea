import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable, SCORE_TABLE } from "../helpers/utils.mjs";

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

  test("pinned header stays at the top of the screen while the page scrolls", async ({ page }) => {
    // 표가 화면보다 길어지도록 뷰포트를 줄인다
    await page.setViewportSize({ width: 1000, height: 300 });
    await page.goto(`/score/public/${YEAR}`);
    await waitForPageReady(page);

    await expect(scoreTable(page)).toBeVisible();
    await expect(page.locator(".head-band th.col-num")).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(() => page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top, SCORE_TABLE))
      .toBeLessThan(0);

    // 표 상단이 화면 위로 지나가도 헤더는 화면 상단에, 그리고 표 안에 남아 있어야 한다
    const rects = await page.evaluate((sel) => {
      const t = document.querySelector(sel).getBoundingClientRect();
      const b = document.querySelector(".head-band").getBoundingClientRect();
      return { bandTop: b.top, bandBottom: b.bottom, tableBottom: t.bottom };
    }, SCORE_TABLE);
    expect(Math.abs(rects.bandTop)).toBeLessThanOrEqual(2);
    expect(rects.bandBottom).toBeLessThanOrEqual(rects.tableBottom + 1);
  });
});
