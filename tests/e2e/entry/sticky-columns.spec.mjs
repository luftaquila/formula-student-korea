import { test, expect } from "@playwright/test";
import { expectCompactTeamIdentity, storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.describe("Entry team table layout", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 500 });
    await page.goto("/entry");
    await waitForPageReady(page);
    await expect(page.locator(".entry-table:not([data-table-head-copy])")).toBeVisible();
  });

  test("uses a pinned page header and one compact mobile identity column", async ({ page }) => {
    const table = page.locator(".entry-table:not([data-table-head-copy])");
    const scroller = page.getByTestId("entry-team-table-scroll");
    const stickyHeader = page.getByTestId("entry-team-sticky-header");
    const firstRow = table.locator("tbody tr").first();

    await expect(table.locator("thead .col-num")).toContainText("엔트리");
    await expect(stickyHeader.locator("th").first()).toContainText("엔트리");
    await expect(page.locator(".sticky-freeze-line")).toHaveCount(0);
    await expect(table).not.toHaveAttribute("data-sticky-cols");
    await expect(firstRow.locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-name")).toBeVisible();
    await expect(firstRow.locator(".team-mobile-entry-type")).toBeVisible();
    await expect(firstRow.locator("td.col-univ")).toBeHidden();
    await expect(firstRow.locator("td.col-team")).toBeHidden();
    await expect(firstRow.locator("td.col-type")).toBeHidden();
    await expectCompactTeamIdentity(table);
    expect(await scroller.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);

    const tableTop = await scroller.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), tableTop + 100);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const headerStyle = await stickyHeader.evaluate((element) => ({
      position: getComputedStyle(element).position,
      top: getComputedStyle(element).top,
    }));
    expect(headerStyle).toEqual({ position: "sticky", top: "0px" });
  });

  test("keeps the original split identity columns on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const table = page.locator(".entry-table:not([data-table-head-copy])");
    const firstRow = table.locator("tbody tr").first();

    await expect(firstRow.locator(".team-mobile-entry-univ")).toBeHidden();
    await expect(firstRow.locator(".team-mobile-entry-name")).toBeHidden();
    await expect(firstRow.locator(".team-mobile-entry-type")).toBeHidden();
    await expect(firstRow.locator("td.col-univ")).toBeVisible();
    await expect(firstRow.locator("td.col-team")).toBeVisible();
    await expect(firstRow.locator("td.col-type")).toBeVisible();
    await expect(firstRow.locator(".badge:visible")).toHaveCount(1);
  });

  test("keeps mobile identity fields editable and remembers type filters", async ({ page }) => {
    const row = page.locator(".entry-table tbody tr").filter({
      has: page.locator(".entry-number", { hasText: /^10$/ }),
    });
    await row.locator(".team-mobile-entry-univ").click();
    await expect(row.locator(".team-mobile-edit-control")).toBeVisible();
    await row.locator(".team-mobile-edit-control").press("Escape");

    const filter = page.getByTestId("entry-team-type-filter");
    const filterRows = await filter.locator("label").evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().top));
    expect(new Set(filterRows.map((top) => Math.round(top))).size).toBe(1);
    const cv = filter.locator('input[value="CV"]');
    await cv.uncheck();
    await expect(page.locator(".entry-table tbody")).not.toContainText("고려대학교");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("entry-team-type-filter"))).toContain('"CV":false');
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("entry-team-type-filter").locator('input[value="CV"]')).not.toBeChecked();
  });
});
