import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const PREV_YEAR = YEAR - 1;
const NEXT_YEAR = YEAR + 1;

async function exposeNextYear(page) {
  await page.route("**/competition/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    await route.fulfill({
      response,
      json: { ...meta, years: [...new Set([...meta.years, NEXT_YEAR])] },
    });
  });
}

test.describe("Competition year boundary", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("keeps historical reads available and rejects historical mutations", async ({ page }) => {
    const teams = await page.request.get(`/competition/api/v1/teams?year=${PREV_YEAR}`);
    expect(teams.status()).toBe(200);
    expect(Array.isArray(await teams.json())).toBe(true);

    const teamWrite = await page.request.post(`/competition/api/v1/teams?year=${PREV_YEAR}`, {
      data: { number: 8080, university: "Historical University", name: "Historical Team" },
    });
    expect(teamWrite.status()).toBe(409);
    expect((await teamWrite.json()).code).toBe("YEAR_READ_ONLY");

    const inspectionWrite = await page.request.post("/competition/api/v1/inspection/sheet/template/import", {
      data: { year: PREV_YEAR, template: [] },
    });
    expect(inspectionWrite.status()).toBe(409);
    expect((await inspectionWrite.json()).code).toBe("YEAR_READ_ONLY");
  });

  test("keeps the current-year Inspection UI writable without finalization", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
    await expect(page.getByTestId("inspection-team-year-filter")).toHaveValue(String(YEAR));
  });

  test("labels a future year as read-only without calling it historical", async ({ page }) => {
    await exposeNextYear(page);
    await page.goto("/inspection");
    await waitForPageReady(page);

    const yearSelect = page.getByTestId("inspection-team-year-filter");
    await yearSelect.selectOption(String(NEXT_YEAR));

    await expect(page.locator(".readonly-banner")).toHaveText("읽기 전용 모드");
  });
});
