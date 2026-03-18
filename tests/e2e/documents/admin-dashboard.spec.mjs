import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Documents admin dashboard", () => {
  test.use({ storageState: storageStatePath("chief") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);
  });

  test("renders dashboard with session data and team list", async ({ page }) => {
    // Verify year selector exists and defaults to current year
    const yearSelect = page.locator(".filter-input").first();
    await expect(yearSelect).toBeVisible();
    await expect(yearSelect).toHaveValue(String(YEAR));

    // Verify team list card renders
    await expect(page.locator("h3").filter({ hasText: "팀 목록" })).toBeVisible();

    // Verify table with entries
    const table = page.locator(".main-table");
    await expect(table).toBeVisible();

    // Verify seeded entries are present
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");

    // Verify the seeded session "E2E 테스트 세션" appears as a column header
    await expect(page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" })).toBeVisible();
  });

  test("student-team mapping is displayed for seeded data", async ({ page }) => {
    // The seeded student e2e-student@test.com is mapped to team 1
    const table = page.locator(".main-table");
    const row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(row).toBeVisible();

    // Check that the student email appears in the account column
    await expect(row.locator(".selected-email")).toContainText("e2e-student@test.com");
  });

  test("adds a student-team mapping via dropdown", async ({ page }) => {
    const table = page.locator(".main-table");

    // Find a team row without a student mapping (e.g., team 2 - 한양대학교)
    const row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(row).toBeVisible();

    // Check that no student is assigned (shows placeholder "-")
    const selectDisplay = row.locator(".select-display");
    await expect(selectDisplay.locator(".select-placeholder")).toHaveText("-");

    // Click to open dropdown
    await selectDisplay.click();

    // Wait for dropdown to appear (fixed position)
    const dropdown = page.locator(".select-dropdown");
    await expect(dropdown).toBeVisible();

    // Search for student
    await dropdown.locator(".select-search").fill("official");

    // Select the official user from dropdown
    const option = dropdown.locator(".select-option").filter({ hasText: "e2e-official@test.com" });
    await option.click();

    // Wait for data to reload
    await waitForPageReady(page);

    // Verify mapping was created
    const updatedRow = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(updatedRow.locator(".selected-email")).toContainText("e2e-official@test.com");

    // Clean up: remove the mapping using the clear button
    await updatedRow.locator(".clear-btn").click();
    await waitForPageReady(page);

    // Verify mapping is cleared
    const clearedRow = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(clearedRow.locator(".select-placeholder")).toHaveText("-");
  });

  test("search filter works on team list", async ({ page }) => {
    const searchInput = page.locator(".filter-input[placeholder*='번호']");
    await expect(searchInput).toBeVisible();

    const table = page.locator(".main-table");

    // Search by university name
    await searchInput.fill("서울");
    const filteredRows = table.locator("tbody tr");
    await expect(filteredRows).toHaveCount(1);
    await expect(filteredRows.first()).toContainText("서울대학교");

    // Search by team number
    await searchInput.fill("10");
    await expect(filteredRows).toHaveCount(1);
    await expect(filteredRows.first()).toContainText("KAIST");

    // Clear search to restore all entries
    await searchInput.fill("");
    await expect(table.locator("tbody tr")).toHaveCount(5);
  });

  test("sort columns work", async ({ page }) => {
    const table = page.locator(".main-table");

    // Click "번호" header to sort ascending (default)
    await table.locator("th.col-num").click();
    const firstNum = table.locator("tbody tr").first().locator(".entry-num");
    await expect(firstNum).toHaveText("1");

    // Click again to sort descending
    await table.locator("th.col-num").click();
    const firstNumDesc = table.locator("tbody tr").first().locator(".entry-num");
    await expect(firstNumDesc).toHaveText("20");
  });

  test("session column links navigate to session detail", async ({ page }) => {
    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await expect(sessionLink).toBeVisible();
    await sessionLink.click();
    await waitForPageReady(page);

    // Should navigate to session detail page
    await expect(page.locator("h3").first()).toContainText("E2E 테스트 세션");
    await expect(page.locator("th").filter({ hasText: "상태" })).toBeVisible();
  });
});
