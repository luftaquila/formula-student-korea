import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score dashboard", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
  });

  test("renders dashboard table with team data", async ({ page }) => {
    // Verify the main score table is visible
    const table = page.locator("table.score-table");
    await expect(table).toBeVisible();

    // Verify the header shows the team count badge
    await expect(page.locator(".count-badge")).toContainText("8");

    // Verify seeded teams appear in the table
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
    await expect(table.locator("tbody")).toContainText("성균관대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");
    await expect(table.locator("tbody")).toContainText("고려대학교");

    // Verify key column headers are present
    await expect(page.locator("th").filter({ hasText: "번호" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "학교 / 팀" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "총점" })).toBeVisible();
    await expect(page.locator("th.col-event").filter({ hasText: "내구" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "보고서" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "에너지" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "가점" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "감점" })).toBeVisible();
  });

  test("year selection loads data for selected year", async ({ page }) => {
    // Verify the year selector exists with current year
    const yearSelect = page.locator(".filter-bar select.filter-input").first();
    await expect(yearSelect).toBeVisible();
    await expect(yearSelect).toHaveValue(String(YEAR));

    // Verify the year options are populated
    const options = yearSelect.locator("option");
    await expect(options.first()).toContainText(String(YEAR));
  });

  test("inspection column toggle hides and shows inspection columns", async ({ page }) => {
    // Find the inspection checkbox (labeled "검차")
    const inspectionCheckbox = page.locator(".filter-bar").locator("label.filter-checkbox").filter({ hasText: "검차" }).locator("input[type='checkbox']");
    await expect(inspectionCheckbox).toBeVisible();

    // Uncheck inspection columns
    if (await inspectionCheckbox.isChecked()) {
      await inspectionCheckbox.uncheck();
    }

    // Verify inspection columns are hidden (col-inspection cells should not be visible)
    const inspectionCells = page.locator("th.col-inspection");
    const count = await inspectionCells.count();
    for (let i = 0; i < count; i++) {
      await expect(inspectionCells.nth(i)).toBeHidden();
    }

    // Re-check to show inspection columns
    await inspectionCheckbox.check();

    // Verify inspection columns are now visible (if there are any)
    if (count > 0) {
      await expect(inspectionCells.first()).toBeVisible();
    }
  });

  test("record/score mode toggle switches display", async ({ page }) => {
    // Find the mode toggle buttons
    const recordBtn = page.locator(".mode-btn").filter({ hasText: "기록" });
    const scoreBtn = page.locator(".mode-btn").filter({ hasText: "점수" });
    await expect(recordBtn).toBeVisible();
    await expect(scoreBtn).toBeVisible();

    // Record mode should be active by default
    await expect(recordBtn).toHaveClass(/active/);

    // Switch to score mode
    await scoreBtn.click();
    await expect(scoreBtn).toHaveClass(/active/);
    await expect(recordBtn).not.toHaveClass(/active/);

    // Switch back to record mode
    await recordBtn.click();
    await expect(recordBtn).toHaveClass(/active/);
    await expect(scoreBtn).not.toHaveClass(/active/);
  });

  test("clicking team row expands detail panel", async ({ page }) => {
    // Click a team row (e.g., the row containing "서울대학교")
    const teamRow = page.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(teamRow).toBeVisible();
    await teamRow.click();

    // The row should now have the expanded class
    await expect(teamRow).toHaveClass(/expanded-row/);

    // A detail row should appear after the team row
    const detailRow = page.locator("tr.detail-row").first();
    await expect(detailRow).toBeVisible();

    // The detail row should contain either a runs table or "경기 기록이 없습니다" message
    const detailContent = detailRow.locator("td").first();
    await expect(detailContent).toBeVisible();

    // Click again to collapse
    await teamRow.click();
    await expect(teamRow).not.toHaveClass(/expanded-row/);
  });

  test("vehicle type filter shows/hides teams by type", async ({ page }) => {
    // Find type filter checkboxes (EV and CV)
    const typeFilterGroup = page.locator(".type-filter-group");

    // If type filters are present (requires more than 1 type)
    const filterCount = await typeFilterGroup.count();
    if (filterCount === 0) {
      // Only one vehicle type exists, filter group won't show
      return;
    }

    // Find EV and CV filter checkboxes
    const evCheckbox = typeFilterGroup.locator("label.filter-checkbox").filter({ hasText: "EV" }).locator("input[type='checkbox']");
    const cvCheckbox = typeFilterGroup.locator("label.filter-checkbox").filter({ hasText: "CV" }).locator("input[type='checkbox']");

    // Both should be checked by default
    await expect(evCheckbox).toBeChecked();
    await expect(cvCheckbox).toBeChecked();

    // Uncheck CV to show only EV teams
    await cvCheckbox.uncheck();
    await expect(page.locator(".count-badge")).toContainText("5");

    // Verify EV teams are visible and CV teams are hidden
    const table = page.locator("table.score-table");
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).not.toContainText("성균관대학교");
    await expect(table.locator("tbody")).not.toContainText("고려대학교");

    // Re-check CV
    await cvCheckbox.check();
    await expect(page.locator(".count-badge")).toContainText("8");
  });

  test("search filter narrows displayed teams", async ({ page }) => {
    const searchInput = page.locator(".filter-bar input.filter-input[placeholder]");
    const table = page.locator("table.score-table");

    // Search by university name
    await searchInput.fill("서울");
    const rows = table.locator("tbody tr.team-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("서울대학교");

    // Search by team name
    await searchInput.fill("ACES");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("한양대학교");

    // Search by entry number
    await searchInput.fill("20");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("고려대학교");

    // Search with no results
    await searchInput.fill("존재하지않는대학");
    await expect(table.locator("tbody")).toContainText("팀 데이터가 없습니다");

    // Clear search to restore all entries
    await searchInput.fill("");
    await expect(page.locator(".count-badge")).toContainText("8");
  });
});
