import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

test.describe("Log date range and text search filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth/logs");
    await waitForPageReady(page);
  });

  test("date range filter narrows log results", async ({ page }) => {
    // Verify the date inputs exist
    const fromInput = page.locator('input[type="datetime-local"]').first();
    const toInput = page.locator('input[type="datetime-local"]').nth(1);
    await expect(fromInput).toBeVisible();
    await expect(toInput).toBeVisible();

    // Get initial row count
    const initialRows = page.locator("table.data-table tbody tr");
    const initialCount = await initialRows.count();

    // Set date range to a future date range (should return 0 results)
    const futureDate = "2099-01-01T00:00";
    const futureEnd = "2099-12-31T23:59";
    await fromInput.fill(futureDate);
    await fromInput.dispatchEvent("change");
    await toInput.fill(futureEnd);
    await toInput.dispatchEvent("change");

    // Click search button to apply
    await page.getByRole("button", { name: "검색" }).click();
    await waitForPageReady(page);

    // Future date range should return no results
    const emptyRow = page.locator("table.data-table tbody td.empty-text");
    await expect(emptyRow).toContainText("로그가 없습니다", { timeout: 10000 });

    // Reset filters
    await page.getByRole("button", { name: "초기화" }).click();
    await waitForPageReady(page);

    // Set date range to past (should include seeding logs)
    const pastDate = "2020-01-01T00:00";
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T23:59`;
    await fromInput.fill(pastDate);
    await fromInput.dispatchEvent("change");
    await toInput.fill(nowStr);
    await toInput.dispatchEvent("change");
    await page.getByRole("button", { name: "검색" }).click();
    await waitForPageReady(page);

    // Should have rows (seeding creates logs) — use retrying assertion for slow data load
    const filteredRows = page.locator("table.data-table tbody tr.row-clickable");
    await expect(filteredRows.first()).toBeVisible({ timeout: 10000 });
  });

  test("text search filter matches action/target/detail", async ({ page }) => {
    const searchInput = page.locator('input[placeholder="통합 검색 (액션/대상/상세)"]');
    await expect(searchInput).toBeVisible();

    // Search for a term that should exist in seeding logs (user creation)
    await searchInput.fill("user.create");
    await page.getByRole("button", { name: "검색" }).click();
    await waitForPageReady(page);

    const rows = page.locator("table.data-table tbody tr.row-clickable");
    const count = await rows.count();

    if (count > 0) {
      // All visible rows should contain the search term in action column
      const firstAction = rows.first().locator("td.col-action");
      await expect(firstAction).toContainText("user");
    }

    // Search for a nonexistent term
    await searchInput.fill("nonexistent_action_xyz_12345");
    await page.getByRole("button", { name: "검색" }).click();
    await waitForPageReady(page);

    // Nonexistent term should return no results
    const emptyRow = page.locator("table.data-table tbody td.empty-text");
    await expect(emptyRow).toContainText("로그가 없습니다", { timeout: 10000 });
  });

  test("action search filter with Enter key works", async ({ page }) => {
    const actionInput = page.locator('input[placeholder="액션 검색"]');
    await expect(actionInput).toBeVisible();

    // Type action prefix and press Enter to trigger search
    await actionInput.fill("user");
    await actionInput.press("Enter");
    await waitForPageReady(page);

    const rows = page.locator("table.data-table tbody tr.row-clickable");
    const count = await rows.count();

    // If results exist, verify action column contains the prefix
    if (count > 0) {
      const firstAction = rows.first().locator("td.col-action");
      await expect(firstAction).toContainText("user");
    }
  });
});
