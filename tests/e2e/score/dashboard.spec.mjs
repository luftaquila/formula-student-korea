import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { expectCompactTeamIdentity, storageStatePath, waitForPageReady, scoreTable, SCORE_TABLE } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Score dashboard", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
  });

  test("renders dashboard table with team data", async ({ page }) => {
    // Verify the main score table is visible
    const table = scoreTable(page);
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
    await expect(table.locator("th").filter({ hasText: "엔트리" })).toBeVisible();
    await expect(table.locator("th.col-team")).toBeHidden();
    await expect(table.locator("tbody tr").first().locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(table.locator("tbody tr").first().locator(".team-mobile-entry-name")).toBeVisible();
    await expect(table.locator("tbody tr").first().locator(".team-mobile-entry-type")).toBeVisible();
    await expectCompactTeamIdentity(table);
    await expect(table.locator("th").filter({ hasText: "총점" })).toBeVisible();
    await expect(table.locator("th.col-event").filter({ hasText: "내구" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "보고서" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "에너지" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "가점" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "감점" })).toBeVisible();
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
    const inspectionCells = scoreTable(page).locator("th.col-inspection");
    const count = await inspectionCells.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(inspectionCells.nth(i)).toBeHidden();
    }

    const pinnedLayout = await page.evaluate(() => {
      const headers = [...document.querySelectorAll(".head-band th")]
        .filter((cell) => getComputedStyle(cell).display !== "none")
        .map((cell) => {
          const rect = cell.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, text: cell.textContent.trim() };
        });
      return {
        headers,
        overlaps: headers.slice(1).some((header, index) => header.left < headers[index].right - 1),
      };
    });
    expect(pinnedLayout.headers.some((header) => header.text.includes("총점"))).toBe(true);
    expect(pinnedLayout.headers.every((header) => header.width > 1)).toBe(true);
    expect(pinnedLayout.overlaps).toBe(false);

    // Re-check to show inspection columns
    await inspectionCheckbox.check();

    await expect(inspectionCells.first()).toBeVisible();
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

    // Global setup creates EV and CV, so a missing filter is a regression.
    await expect(typeFilterGroup).toBeVisible();

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
    const table = scoreTable(page);
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).not.toContainText("성균관대학교");
    await expect(table.locator("tbody")).not.toContainText("고려대학교");

    // Re-check CV
    await cvCheckbox.check();
    await expect(page.locator(".count-badge")).toContainText("8");
  });

  test("table header stays at the top of the screen while the page scrolls", async ({ page }) => {
    // 표가 화면보다 길어지도록 뷰포트를 줄인다
    await page.setViewportSize({ width: 1280, height: 360 });

    const table = scoreTable(page);
    const band = page.locator(".head-band");
    await expect(table).toBeVisible();
    await expect(band.locator("th").first()).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(() => page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top, SCORE_TABLE))
      .toBeLessThan(0);

    const rects = await page.evaluate((sel) => {
      const t = document.querySelector(sel).getBoundingClientRect();
      const b = document.querySelector(".head-band").getBoundingClientRect();
      return { bandTop: b.top, bandBottom: b.bottom, tableTop: t.top, tableBottom: t.bottom };
    }, SCORE_TABLE);
    // 표 상단은 화면 위로 지나갔지만 헤더는 화면 상단에, 그리고 표 안에 남아 있어야 한다
    expect(rects.tableTop).toBeLessThan(0);
    expect(Math.abs(rects.bandTop)).toBeLessThanOrEqual(2);
    expect(rects.bandBottom).toBeLessThanOrEqual(rects.tableBottom + 1);

    // 되돌리면 원래 자리로
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() => page.evaluate((sel) => {
        const t = document.querySelector(sel).getBoundingClientRect();
        return document.querySelector(".head-band").getBoundingClientRect().top - t.top;
      }, SCORE_TABLE))
      .toBeLessThanOrEqual(1);
  });

  test("the pinned header tracks the table's own horizontal scroll", async ({ page }) => {
    // 가로 스크롤은 페이지가 아니라 표 안에서 일어나야 한다
    await page.setViewportSize({ width: 700, height: 500 });
    await expect(scoreTable(page)).toBeVisible();

    const state = () => page.evaluate(() => {
      const scroller = document.querySelector(".sticky-host .table-container");
      const lastReal = scroller.querySelector("thead tr").lastElementChild.getBoundingClientRect();
      const lastBand = document.querySelector(".head-band thead tr").lastElementChild.getBoundingClientRect();
      const numBand = document.querySelector(".head-band th").getBoundingClientRect();
      return {
        pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        tableScrollsX: scroller.scrollWidth > scroller.clientWidth,
        lastReal: lastReal.left, lastBand: lastBand.left, numBand: numBand.left,
      };
    });

    const before = await state();
    expect(before.tableScrollsX).toBe(true);
    expect(before.pageScrollsX).toBe(false);
    expect(Math.abs(before.lastReal - before.lastBand)).toBeLessThanOrEqual(1);

    await page.evaluate(() => { document.querySelector(".sticky-host .table-container").scrollLeft = 250; });
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".head-band").scrollLeft))
      .toBeGreaterThan(0);

    // 고정 헤더는 표와 같은 만큼 밀리고, 고정열은 제자리에 남는다
    const after = await state();
    expect(after.lastReal).toBeLessThan(before.lastReal);
    expect(Math.abs(after.lastReal - after.lastBand)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.numBand - before.numBand)).toBeLessThanOrEqual(1);
  });

  test("combines team identity on mobile and remembers the vehicle type filter", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    const table = scoreTable(page);
    const firstRow = table.locator("tbody tr.team-row").first();

    await expect(page.locator(".sticky-freeze-line")).toHaveCount(0);
    await expect(table).not.toHaveAttribute("data-sticky-cols");
    await expect(firstRow.locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-name")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-type")).toBeVisible();
    await expect(firstRow.locator("td.col-team")).toBeHidden();
    await expect(firstRow.locator("td.col-type")).toBeHidden();
    await expectCompactTeamIdentity(table);

    const cvCheckbox = page.getByTestId("score-team-type-filter").locator("label", { hasText: "CV" }).locator("input");
    await cvCheckbox.uncheck();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("score-board-type-filter"))).toContain('"CV":false');
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("score-team-type-filter").locator("label", { hasText: "CV" }).locator("input")).not.toBeChecked();
  });

  test("search filter narrows displayed teams", async ({ page }) => {
    const searchInput = page.locator(".filter-bar input.filter-input[placeholder]");
    const table = scoreTable(page);

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
