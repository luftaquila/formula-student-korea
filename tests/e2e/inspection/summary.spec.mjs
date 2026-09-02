import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { completeInspectionCategory, restoreInspectionAnswers } from "../helpers/inspection.mjs";

const YEAR = currentCompetitionYear();

test.describe("Inspection summary dashboard", () => {
  test.use({ storageState: storageStatePath("official") });

  test("renders team list with all seeded entries", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    // Verify the page title/header
    await expect(page.locator("h3")).toContainText("검차 시트");

    // Verify entry count badge
    await expect(page.locator(".count-badge")).toHaveText("11개 팀");

    // Verify the table is visible
    const table = page.locator(".sheet-table");
    await expect(table).toBeVisible();

    // Verify all base and inspection-only seeded teams are in the table
    const rows = table.locator("tbody tr.clickable-row");
    await expect(rows).toHaveCount(11);

    // Verify specific team names
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
    await expect(table.locator("tbody")).toContainText("성균관대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");
    await expect(table.locator("tbody")).toContainText("고려대학교");
  });

  test("renders category columns in the table header", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");
    const headers = table.locator("thead th");

    // Should have: 엔트리, 학교/팀, 유형, + visible category columns
    // Seeded categories are "전기 검차" and "샤시 검차"
    await expect(headers.filter({ hasText: /^엔트리$/ })).toBeVisible();
    await expect(headers.filter({ hasText: "전기 검차" })).toBeVisible();
    await expect(headers.filter({ hasText: "샤시 검차" })).toBeVisible();
    await expect(page.locator(".sticky-freeze-line")).toHaveCount(0);
    await expect(table).not.toHaveAttribute("data-sticky-cols");
  });

  test("opens the selected category when a team result cell is clicked", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");
    const chassisHeader = table.locator("thead .col-result").filter({ hasText: "샤시 검차" });
    const categoryIndex = await table.locator("thead .col-result").allTextContents()
      .then(headers => headers.findIndex(header => header.includes("샤시 검차")));
    expect(categoryIndex).toBeGreaterThanOrEqual(0);
    await expect(chassisHeader).toBeVisible();

    const row = table.locator("tbody tr.clickable-row").filter({ hasText: "서울대학교" });
    const cell = row.locator(".col-result").nth(categoryIndex);
    const categoryId = await cell.getAttribute("data-category-id");
    await cell.click();

    await expect(page).toHaveURL(new RegExp(`/inspection/${YEAR}/1\\?category=${categoryId}$`));
    await expect(page.locator(".tabs .tab.active")).toContainText("샤시 검차");
  });

  test("remembers the selected vehicle type filter", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const filter = page.getByTestId("inspection-team-type-filter");
    const checkboxes = filter.locator('input[type="checkbox"]');
    const rows = page.locator(".sheet-table tbody tr.clickable-row");
    const evCount = await rows.locator(".col-type").allTextContents()
      .then(types => types.filter(type => type.trim() === "EV").length);
    expect(evCount).toBeGreaterThan(0);
    await expect(checkboxes).not.toHaveCount(0);
    await expect(filter.locator('input[value="EV"]')).toBeChecked();

    for (const checkbox of await checkboxes.all()) {
      if (await checkbox.getAttribute("value") !== "EV") await checkbox.uncheck();
    }
    await expect(rows).toHaveCount(evCount);
    await expect(rows.locator(".col-type")).toHaveText(Array(evCount).fill("EV"));
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("inspection-team-type-filter")))).toMatchObject({ EV: true });

    await page.reload();
    await waitForPageReady(page);
    await expect(filter.locator('input[value="EV"]')).toBeChecked();
    for (const checkbox of await filter.locator('input[type="checkbox"]:not([value="EV"])').all()) {
      await expect(checkbox).not.toBeChecked();
    }
    await expect(rows).toHaveCount(evCount);
  });

  test("keeps the table header fixed while the page scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 520 });
    await page.goto("/inspection");
    await waitForPageReady(page);

    const scroller = page.getByTestId("inspection-team-table-scroll");
    const stickyHeader = page.getByTestId("inspection-team-sticky-header");
    const tableTop = await scroller.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect.poll(() => stickyHeader.evaluate(element => element.getBoundingClientRect().height > 0)).toBe(true);

    await page.evaluate(top => window.scrollTo({ top, behavior: "instant" }), tableTop + 100);

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(0);
    const after = await stickyHeader.boundingBox();
    expect(Math.abs(after.y)).toBeLessThanOrEqual(1);
    const styles = await stickyHeader.evaluate(element => ({
      position: getComputedStyle(element).position,
      top: getComputedStyle(element).top,
    }));
    expect(styles).toEqual({ position: "sticky", top: "0px" });
  });

  test("combines entry, team, and vehicle type into one compact mobile column", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");
    const scroller = page.getByTestId("inspection-team-table-scroll");
    const stickyHeader = page.getByTestId("inspection-team-sticky-header");
    const stickyEntry = stickyHeader.locator(".sticky-header-cell.col-num");
    const row = table.locator("tbody tr.clickable-row").first();
    await expect(table.locator("thead .col-num")).toHaveText("엔트리");
    await expect(stickyEntry).toHaveText("엔트리");
    await expect(row.locator(".mobile-entry-univ")).toHaveText("서울대학교");
    await expect(row.locator(".mobile-entry-team")).toHaveText("SNU Racing");
    await expect(row.locator(".mobile-entry-type")).toHaveText("EV");

    const layout = await row.evaluate((element) => {
      const entry = element.querySelector(".col-num").getBoundingClientRect();
      const firstResult = element.querySelector(".col-result").getBoundingClientRect();
      return {
        entryWidth: entry.width,
        resultOffset: firstResult.left - entry.left,
        teamDisplay: getComputedStyle(element.querySelector(".col-team")).display,
        typeDisplay: getComputedStyle(element.querySelector(".col-type")).display,
      };
    });
    expect(layout.entryWidth).toBeLessThanOrEqual(152);
    expect(layout.resultOffset).toBeLessThanOrEqual(152);
    expect(layout.teamDisplay).toBe("none");
    expect(layout.typeDisplay).toBe("none");

    await expect.poll(() => scroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    const stickyLayout = await stickyEntry.evaluate((element) => {
      const cell = element.getBoundingClientRect();
      const viewport = element.closest(".page-sticky-header-viewport").getBoundingClientRect();
      return {
        leftOffset: cell.left - viewport.left,
        width: cell.width,
        textFits: element.scrollWidth <= element.clientWidth + 1,
      };
    });
    expect(Math.abs(stickyLayout.leftOffset)).toBeLessThanOrEqual(1);
    expect(stickyLayout.width).toBeGreaterThanOrEqual(147);
    expect(stickyLayout.textFits).toBe(true);
  });

  test("collapses five or more inspectors without hiding the full list", async ({ page }) => {
    const inspectors = ["김검차", "이검차", "박검차", "최검차", "정검차"];
    await page.route("**/competition/api/v1/inspection/sheet/summary?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const category = body.categories[0];
      body.teams[1] ||= { inspectors: {}, results: {} };
      body.teams[1].inspectors ||= {};
      body.teams[1].inspectors[category.id] = inspectors;
      await route.fulfill({ response, json: body });
    });

    await page.goto("/inspection");
    await waitForPageReady(page);
    const row = page.locator(".sheet-table tbody tr.clickable-row").filter({ hasText: "서울대학교" });
    const disclosure = row.locator(".inspector-disclosure").first();
    const toggle = disclosure.locator("summary");

    await expect(toggle.locator(".inspector-preview")).toHaveText("김검차, 이검차");
    await expect(toggle.locator(".inspector-more")).toHaveText("외 3명");
    await expect(toggle).toHaveAttribute("title", inspectors.join(", "));
    expect(await toggle.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(160);

    await toggle.click();
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator(".inspector-person")).toHaveCount(5);
    await expect(disclosure.locator(".inspector-person").last()).toBeVisible();
    await expect(disclosure.locator(".inspector-list")).toContainText("정검차");
    await expect(page).toHaveURL(/\/inspection\/?$/);
  });

  test("shows category result badges after setting results", async ({ page, browser }) => {
    // Use a team this spec owns exclusively (연세대학교, #31) so a parallel
    // inspection spec mutating team 1's result can't clear the badge before
    // this assertion runs. The team is seeded, so it shows in the table.
    const TEAM = 31;
    const TEAM_UNIV = "연세대학교";

    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const apiPage = await context.newPage();

    // Get the template to find category IDs
    const templateRes = await apiPage.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstCategory = template[0];
    const firstCatId = firstCategory.id;
    const completionChanges = await completeInspectionCategory({
      year: YEAR,
      teamNum: TEAM,
      category: firstCategory,
      role: "official",
    });

    // Set category result to PASS for the team
    await apiPage.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: firstCatId, result: "PASS" },
    });

    await context.close();

    // Now navigate to summary and verify the badge on this team's row
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");
    const teamRow = table.locator("tbody tr.clickable-row").filter({ hasText: TEAM_UNIV });
    const passBadge = teamRow.locator(".badge-success").first();
    await expect(passBadge).toContainText("PASS");
    await expect(teamRow.locator(".inspector-name").first()).toContainText("E2E Official");

    // Clean up mutable values. Inspector participation intentionally remains as history.
    const cleanupCtx = await browser.newContext({ storageState: storageStatePath("official") });
    const cleanupPage = await cleanupCtx.newPage();
    await cleanupPage.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: firstCatId, result: "" },
    });
    await restoreInspectionAnswers({
      year: YEAR,
      teamNum: TEAM,
      changes: completionChanges,
      role: "official",
    });
    await cleanupCtx.close();
  });

  test("filters teams using search input", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const searchInput = page.locator('.filter-input[placeholder*="엔트리"]');
    const table = page.locator(".sheet-table");
    const rows = table.locator("tbody tr.clickable-row");

    // Search by university name
    await searchInput.fill("서울");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("서울대학교");

    // Search by team name
    await searchInput.fill("ACES");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("한양대학교");

    // Search by team number
    await searchInput.fill("10");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("KAIST");

    // Search with no results
    await searchInput.fill("존재하지않는팀");
    await expect(table.locator("tbody")).toContainText("팀 데이터가 없습니다");

    // Clear search restores all entries
    await searchInput.fill("");
    await expect(rows).toHaveCount(11);
  });

  test("navigates to team sheet on row click", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");

    // Click the first team row (team #1)
    const firstRow = table.locator("tbody tr.clickable-row").first();
    await firstRow.click();

    // Should navigate to the sheet detail page
    await page.waitForURL(`**/inspection/${YEAR}/1`);
    await waitForPageReady(page);

    // Verify we're on the detail page
    await expect(page.locator(".team-header")).toContainText("#1");
    await expect(page.locator(".team-header")).toContainText("서울대학교");
  });

  test("shows empty badge placeholders for teams without results", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    const table = page.locator(".sheet-table");

    // For teams without results, empty badges ("-") should be shown
    const emptyBadges = table.locator("tbody .badge-empty");
    const count = await emptyBadges.count();

    // All 5 teams * 2 categories = 10 total cells, all should be empty by default
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
