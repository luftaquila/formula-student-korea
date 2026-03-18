import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

test.describe("System logs page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth/logs");
    await waitForPageReady(page);
  });

  test("log page renders with header and table", async ({ page }) => {
    // Verify page title
    await expect(page.locator("h3").filter({ hasText: "시스템 로그" })).toBeVisible();

    // Verify the log table is present
    const table = page.locator("table.data-table");
    await expect(table).toBeVisible();

    // Verify table headers
    await expect(page.locator("th").filter({ hasText: "시간" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "서비스" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "레벨" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "액션" })).toBeVisible();
  });

  test("log table contains entries from seeding actions", async ({ page }) => {
    // The seeding process creates users and entries, so there should be log rows
    const rows = page.locator("table.data-table tbody tr");
    await expect(rows.first()).toBeVisible();

    // At least one row should exist (user creation logs from seeding)
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("service filter dropdown works", async ({ page }) => {
    // Open the service filter dropdown and select "auth"
    const serviceSelect = page.locator("select.filter-select").first();
    await expect(serviceSelect).toBeVisible();

    await serviceSelect.selectOption("auth");

    // Wait for the table to reload
    await waitForPageReady(page);

    // All visible service badges should be "auth"
    const serviceBadges = page.locator("table.data-table tbody .badge-primary");
    const count = await serviceBadges.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        await expect(serviceBadges.nth(i)).toHaveText("auth");
      }
    }
  });

  test("level filter dropdown works", async ({ page }) => {
    const levelSelect = page.locator("select.filter-select").nth(1);
    await expect(levelSelect).toBeVisible();

    // Filter by "info" level
    await levelSelect.selectOption("info");

    // Wait for the table to reload
    await waitForPageReady(page);

    // All visible level badges should be "info" (badge-success class)
    const levelBadges = page.locator("table.data-table tbody .badge-success");
    const count = await levelBadges.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        await expect(levelBadges.nth(i)).toHaveText("info");
      }
    }
  });

  test("pagination controls are visible when logs exist", async ({ page }) => {
    // Check that pagination section is present
    const pagination = page.locator(".pagination");

    // Pagination only shows when total > 0
    const rows = page.locator("table.data-table tbody tr");
    const count = await rows.count();

    if (count > 0) {
      await expect(pagination).toBeVisible();
      await expect(pagination.locator(".page-info")).toBeVisible();
      await expect(pagination.getByRole("button", { name: "이전" })).toBeVisible();
      await expect(pagination.getByRole("button", { name: "다음" })).toBeVisible();

      // First page: "이전" button should be disabled
      await expect(pagination.getByRole("button", { name: "이전" })).toBeDisabled();
    }
  });

  test("reset filters button clears all filters", async ({ page }) => {
    // Set a filter first
    const serviceSelect = page.locator("select.filter-select").first();
    await serviceSelect.selectOption("auth");
    await waitForPageReady(page);

    // Click reset button
    await page.getByRole("button", { name: "초기화" }).click();
    await waitForPageReady(page);

    // Service dropdown should be back to default (empty value = "전체 서비스")
    await expect(serviceSelect).toHaveValue("");
  });

  test("clicking a log row opens detail modal", async ({ page }) => {
    // Wait for at least one log row
    const firstRow = page.locator("table.data-table tbody tr.row-clickable").first();
    const rowCount = await page.locator("table.data-table tbody tr").count();

    if (rowCount > 0) {
      await firstRow.click();

      // Modal should appear
      const modal = page.locator(".modal-box");
      await expect(modal).toBeVisible();
      await expect(modal.locator(".modal-title")).toHaveText("로그 상세");

      // Close modal
      await modal.locator(".modal-close").click();
      await expect(modal).not.toBeVisible();
    }
  });
});
