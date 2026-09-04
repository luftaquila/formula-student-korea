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
      json: {
        ...meta,
        years: [...new Set([...meta.years, NEXT_YEAR])].sort((a, b) => b - a),
      },
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

  test("allows next-year Inspection sheet preparation", async ({ page }, testInfo) => {
    await exposeNextYear(page);
    const teamNumber = 909000 + testInfo.retry;
    const team = await page.request.post(`/competition/api/v1/teams?year=${NEXT_YEAR}`, {
      data: { number: teamNumber, university: "Next University", name: "Next Team" },
    });
    expect(team.status()).toBe(201);

    const category = await page.request.post("/competition/api/v1/inspection/sheet/template", {
      data: { year: NEXT_YEAR, level: "category", name: "Next Inspection" },
    });
    expect(category.status()).toBe(200);
    const categoryId = Number((await category.json()).id);
    const subcategory = await page.request.post("/competition/api/v1/inspection/sheet/template", {
      data: { year: NEXT_YEAR, level: "subcategory", parent_id: categoryId, name: "Next Subcategory" },
    });
    expect(subcategory.status()).toBe(200);
    const subcategoryId = Number((await subcategory.json()).id);
    const group = await page.request.post("/competition/api/v1/inspection/sheet/template", {
      data: { year: NEXT_YEAR, level: "group", parent_id: subcategoryId, name: "Next Group" },
    });
    expect(group.status()).toBe(200);
    const groupId = Number((await group.json()).id);
    const item = await page.request.post("/competition/api/v1/inspection/sheet/template", {
      data: {
        year: NEXT_YEAR,
        level: "item",
        parent_id: groupId,
        name: "Next Inspection Item",
        answer_type: "passfail",
      },
    });
    expect(item.status()).toBe(200);

    await page.goto("/inspection");
    await waitForPageReady(page);

    const yearSelect = page.getByTestId("inspection-team-year-filter");
    await expect(yearSelect).toHaveValue(String(YEAR));
    const yearOptions = await yearSelect.locator("option").evaluateAll((options) =>
      options.map((option) => Number(option.value)),
    );
    expect(yearOptions[0]).toBe(NEXT_YEAR);
    expect(yearOptions).toEqual([...yearOptions].sort((a, b) => b - a));
    await yearSelect.selectOption(String(NEXT_YEAR));
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
    await expect(page.locator("tr.clickable-row").filter({ hasText: `#${teamNumber}` })).toBeVisible();

    await page.goto(`/inspection/${NEXT_YEAR}/${teamNumber}`);
    await waitForPageReady(page);
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
    const itemRow = page.locator(".item-row").filter({ hasText: "Next Inspection Item" });
    const passButton = itemRow.locator(".pf-toggle button").first();
    await expect(passButton).toBeEnabled();
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/competition/api/v1/inspection/sheet/answer")
      && response.request().method() === "PUT",
    );
    await passButton.click();
    expect((await saved).status()).toBe(200);
    await expect(passButton).toHaveClass(/btn-success/);
  });
});
