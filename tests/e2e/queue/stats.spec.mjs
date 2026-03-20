import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.describe("Queue statistics page", () => {
  test.use({ storageState: storageStatePath("official") });

  test("loads /queue/stats page with filter bar and table", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    // Should show back button
    await expect(page.getByRole("button", { name: "돌아가기" })).toBeVisible();

    // Should show filter bar with date filters and inspection select
    await expect(page.getByText("시작")).toBeVisible();
    await expect(page.getByText("종료")).toBeVisible();
    await expect(page.getByText("검차 종류")).toBeVisible();

    // Should show the stats table
    await expect(page.getByRole("heading", { name: /팀별 통계/ })).toBeVisible();
  });

  test("stats table has correct column headers", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    const table = page.locator(".stats-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Check column headers
    await expect(page.locator("th", { hasText: "번호" })).toBeVisible();
    await expect(page.locator("th", { hasText: "팀" })).toBeVisible();
    await expect(page.locator("th", { hasText: "등록" })).toBeVisible();
    await expect(page.locator("th", { hasText: "취소" })).toBeVisible();
    await expect(page.locator("th", { hasText: "입장" })).toBeVisible();
    await expect(page.locator("th", { hasText: "검차 시간" })).toBeVisible();
  });

  test("year selector is available", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    // Should show year (entry) selector
    const yearSelect = page.locator(".filter-group", { hasText: "엔트리" }).locator("select");
    await expect(yearSelect).toBeVisible({ timeout: 10000 });
  });

  test("date filter inputs are functional", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    // Should show date inputs
    const dateInputs = page.locator('input[type="date"]');
    await expect(dateInputs.first()).toBeVisible({ timeout: 10000 });
    const count = await dateInputs.count();
    expect(count).toBe(2); // from and to
  });

  test("inspection type filter dropdown is available", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    const inspectionSelect = page.locator(".filter-group", { hasText: "검차 종류" }).locator("select");
    await expect(inspectionSelect).toBeVisible({ timeout: 10000 });

    // Should have "전체" option and inspection types
    const options = inspectionSelect.locator("option");
    const optCount = await options.count();
    expect(optCount).toBeGreaterThan(1); // at least "전체" + some types
    await expect(options.first()).toHaveText("전체");
  });

  test("table columns are sortable", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    const table = page.locator(".stats-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Click on a sortable column header
    const numHeader = page.locator("th.sortable", { hasText: "번호" });
    await numHeader.click();

    // Should show sort indicator
    await expect(numHeader).toContainText(/▲|▼/);

    // Click again to reverse
    await numHeader.click();
    await expect(numHeader).toContainText(/▲|▼/);
  });

  test("back button navigates to admin page", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    await page.getByRole("button", { name: "돌아가기" }).click();
    await expect(page).toHaveURL(/\/queue\/admin/);
  });

  test("clicking a team row expands timeline detail", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    const table = page.locator(".stats-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Click on the first team row to expand timeline
    const firstRow = table.locator("tbody .clickable-row").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    // Should show the timeline section
    const timelineSection = page.locator(".timeline-section");
    await expect(timelineSection).toBeVisible({ timeout: 5000 });

    // Should show timeline header with team info
    const timelineHeader = page.locator(".timeline-header h4");
    await expect(timelineHeader).toContainText("타임라인");

    // Should show either timeline data or empty message
    const hasTable = await page.locator(".timeline-table").isVisible().catch(() => false);
    const hasEmpty = await page.locator(".timeline-empty").isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);

    // Click again to collapse
    await firstRow.click();
    await expect(timelineSection).not.toBeVisible();
  });

  test("filtering by inspection type updates the table", async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);

    const inspectionSelect = page.locator(".filter-group", { hasText: "검차 종류" }).locator("select");
    await expect(inspectionSelect).toBeVisible({ timeout: 10000 });

    // Select a specific inspection type
    await inspectionSelect.selectOption({ index: 1 });

    // The count badge should still be visible
    await expect(page.locator(".count-badge")).toBeVisible();
  });
});
