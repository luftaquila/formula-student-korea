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
    // Wait for log API data to load before checking rows
    const rows = page.locator("table.data-table tbody tr.row-clickable");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
  });

  test("service filter dropdown works", async ({ page }) => {
    // Open the service multi-select dropdown
    const serviceDropdown = page.locator(".multi-select").first();
    await serviceDropdown.locator(".multi-select-trigger").click();
    await expect(serviceDropdown.locator(".multi-select-dropdown")).toBeVisible();

    // Uncheck "전체" to deselect all, then check only "auth"
    await serviceDropdown.locator(".multi-select-item").filter({ hasText: "전체" }).click();
    const apiResponse = page.waitForResponse(
      (res) => res.url().includes("/api/admin/logs") && res.status() === 200
    );
    await serviceDropdown.locator(".multi-select-item").filter({ hasText: "auth" }).click();
    await apiResponse;

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
    // Open the level multi-select dropdown
    const levelDropdown = page.locator(".multi-select").nth(1);
    await levelDropdown.locator(".multi-select-trigger").click();
    await expect(levelDropdown.locator(".multi-select-dropdown")).toBeVisible();

    // Uncheck "전체" to deselect all, then check only "info"
    await levelDropdown.locator(".multi-select-item").filter({ hasText: "전체" }).click();
    const apiResponse = page.waitForResponse(
      (res) => res.url().includes("/api/admin/logs") && res.status() === 200
    );
    await levelDropdown.locator(".multi-select-item").filter({ hasText: "info" }).click();
    await apiResponse;

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
    // Wait for log data to load
    const rows = page.locator("table.data-table tbody tr.row-clickable");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // Check that pagination section is present
    const pagination = page.locator(".pagination");
    await expect(pagination).toBeVisible();
    await expect(pagination.locator(".page-info")).toBeVisible();
    await expect(pagination.getByRole("button", { name: "이전" })).toBeVisible();
    await expect(pagination.getByRole("button", { name: "다음" })).toBeVisible();

    // First page: "이전" button should be disabled
    await expect(pagination.getByRole("button", { name: "이전" })).toBeDisabled();
  });

  test("reset filters button clears all filters", async ({ page }) => {
    // Set a filter: select only "auth" service
    const serviceDropdown = page.locator(".multi-select").first();
    const serviceTrigger = serviceDropdown.locator(".multi-select-trigger");
    await serviceTrigger.click();
    await expect(serviceDropdown.locator(".multi-select-dropdown")).toBeVisible();
    await serviceDropdown.locator(".multi-select-item").filter({ hasText: "전체" }).click();
    const filterResponse = page.waitForResponse(
      (res) => res.url().includes("/api/admin/logs") && res.status() === 200
    );
    await serviceDropdown.locator(".multi-select-item").filter({ hasText: "auth" }).click();
    await filterResponse;

    // Close dropdown by clicking header
    await page.locator("h3").click();

    // Click reset button
    const resetResponse = page.waitForResponse(
      (res) => res.url().includes("/api/admin/logs") && res.status() === 200
    );
    await page.getByRole("button", { name: "초기화" }).click();
    await resetResponse;

    // Service dropdown trigger should show "전체 서비스"
    await expect(serviceTrigger).toHaveText("전체 서비스");
  });

  test("clicking a log row opens detail modal", async ({ page }) => {
    // Wait for log data to load
    const firstRow = page.locator("table.data-table tbody tr.row-clickable").first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });
    await firstRow.click();

    // Modal should appear
    const modal = page.locator(".modal-box");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-title")).toHaveText("로그 상세");

    // Close modal
    await modal.locator(".modal-close").click();
    await expect(modal).not.toBeVisible();
  });
});
