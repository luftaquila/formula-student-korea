import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "battery";

async function apiResetPriorities(type = INSPECTION_TYPE) {
  await fetch(`${BASE_URL}/queue/api/admin/priority/${type}/all`, {
    method: "DELETE",
    headers: { Cookie: getAuthCookie("chief") },
  });
}

test.describe("Queue priority management", () => {
  test.use({ storageState: storageStatePath("chief") });

  test.beforeEach(async () => {
    await apiResetPriorities();
  });

  test.afterEach(async () => {
    await apiResetPriorities();
  });

  test("loads /queue/priority page with team table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Should show the priority rules section
    await expect(page.getByText("우선순위 규칙")).toBeVisible();

    // Should show inspection settings section
    await expect(page.getByRole("heading", { name: "검차별 설정" })).toBeVisible();

    // Should show team priority table
    await expect(page.getByRole("heading", { name: /팀별 우선순위 설정/ })).toBeVisible();

    // Should show back button
    await expect(page.getByRole("button", { name: "돌아가기" })).toBeVisible();
  });

  test("shows entries in priority table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Wait for the table to load
    const table = page.locator(".priority-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Should show entry numbers from seeded data
    await expect(page.locator(".priority-table .entry-num", { hasText: "1" })).toBeVisible();
    await expect(page.locator(".priority-table .entry-num", { hasText: "2" })).toBeVisible();
    await expect(page.locator(".priority-table .entry-num", { hasText: "3" })).toBeVisible();
  });

  test("set team priority via input", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Wait for table to load
    await expect(page.locator(".priority-table")).toBeVisible({ timeout: 10000 });

    // Find the first priority input in the row for entry 1
    const row = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^1$/ }) });
    const priorityInput = row.locator(".priority-input").first();
    await expect(priorityInput).toBeVisible();

    // Set priority to 1
    await priorityInput.fill("1");
    await priorityInput.dispatchEvent("change");

    // Should show success notification
    await expectNotification(page, "success", "우선순위");
  });

  test("remove team priority by clearing input", async ({ page }) => {
    // First set a priority via API
    await fetch(`${BASE_URL}/queue/api/admin/priority/${INSPECTION_TYPE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ num: 2, priority: 1 }),
    });

    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await expect(page.locator(".priority-table")).toBeVisible({ timeout: 10000 });

    // Find the priority input for entry 2 in the battery column
    const row = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^2$/ }) });
    const priorityInput = row.locator(".priority-input").first();
    await expect(priorityInput).toBeVisible();

    // The input should show current priority
    await expect(priorityInput).toHaveValue("1");

    // Clear the input to remove priority
    await priorityInput.fill("");
    await priorityInput.dispatchEvent("change");

    // Should show success notification about removal
    await expectNotification(page, "success", "우선순위 해제");
  });

  test("search filters entries in the table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await expect(page.locator(".priority-table")).toBeVisible({ timeout: 10000 });

    // Use search input
    const searchInput = page.locator(".search-input");
    await searchInput.fill("서울");

    // Should filter to only show matching entries
    const visibleRows = page.locator(".priority-table tbody tr");
    await expect(visibleRows).toHaveCount(1);
    await expect(visibleRows.first()).toContainText("서울대학교");
  });

  test("back button navigates to admin page", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await page.getByRole("button", { name: "돌아가기" }).click();
    await expect(page).toHaveURL(/\/queue\/admin/);
  });

  test("shows inspection config toggles", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Should show inspection settings with toggle buttons
    const configItems = page.locator(".inspection-config");
    await expect(configItems.first()).toBeVisible({ timeout: 10000 });
    const count = await configItems.count();
    expect(count).toBeGreaterThan(0);

    // Each item should have config toggle buttons
    const toggles = page.locator(".btn-config-toggle");
    const toggleCount = await toggles.count();
    expect(toggleCount).toBeGreaterThan(0);
  });
});
