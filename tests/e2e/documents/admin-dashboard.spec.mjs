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

    // Search for the second student user (dropdown only shows student-role users)
    await dropdown.locator(".select-search").fill("student2");

    // Select the student user from dropdown
    const option = dropdown.locator(".select-option").filter({ hasText: "e2e-student2@test.com" });
    await option.click();

    // Wait for data to reload
    await waitForPageReady(page);

    // Verify mapping was created
    const updatedRow = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(updatedRow.locator(".selected-email")).toContainText("e2e-student2@test.com");

    // Clean up: remove the mapping using the clear button
    await updatedRow.locator(".clear-btn").click();
    await waitForPageReady(page);

    // Verify mapping is cleared
    const clearedRow = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(clearedRow.locator(".select-placeholder")).toHaveText("-");
  });

  test("deletes student-team mapping via clear button", async ({ page }) => {
    const table = page.locator(".main-table");

    // Use a team + email this test owns exclusively. student_team has
    // PRIMARY KEY(email, year) and UNIQUE(team_num, year), so sharing the email
    // or team with the dropdown test (team 2 / e2e-student2) lets a leftover or
    // parallel mapping make this INSERT hit the unique constraint (flaky 400).
    const TEAM_UNIV = "성균관대학교"; // team #3, not mapped by any other test
    const EMAIL = "e2e-clear-test@test.com";

    // Idempotency: a run that fails before the clear step below leaves this
    // mapping behind, so the next attempt's INSERT would 400 on the unique
    // constraint. Remove any leftover up front, and again in `finally` so a
    // mid-test failure can't poison a retry. DELETE is keyed by email+year.
    const removeMapping = () =>
      page.request.delete(`/documents/api/admin/student-teams/${encodeURIComponent(EMAIL)}/${YEAR}`);
    await removeMapping();

    try {
      const row = table.locator("tbody tr").filter({ hasText: TEAM_UNIV });
      await expect(row).toBeVisible();

      // Create a mapping via API first
      const res = await page.request.post("/documents/api/admin/student-teams", {
        data: { email: EMAIL, team_num: 3, year: YEAR },
      });
      expect(res.ok()).toBeTruthy();

      // Reload, then wait for the dashboard's mapping fetch to resolve before
      // asserting. reload() only guarantees domcontentloaded, not that the
      // table data has loaded, so asserting straight away races the fetch under
      // CI load — that race was the flake. (waitForResponse set up before the
      // navigation that triggers it, per the deterministic-wait policy.)
      const mappingsLoaded = page.waitForResponse(
        (r) => r.url().includes("/api/admin/student-teams") && r.request().method() === "GET" && r.ok(),
      );
      await page.reload();
      await mappingsLoaded;

      // Verify mapping is shown
      const mappedRow = table.locator("tbody tr").filter({ hasText: TEAM_UNIV });
      await expect(mappedRow.locator(".selected-email")).toContainText(EMAIL);

      // Click the clear button; clearStudent() DELETEs then re-fetches the
      // mappings, so wait on that GET for a deterministic cleared state.
      const mappingsReloaded = page.waitForResponse(
        (r) => r.url().includes("/api/admin/student-teams") && r.request().method() === "GET" && r.ok(),
      );
      await mappedRow.locator(".clear-btn").click();
      await mappingsReloaded;

      // Verify mapping is cleared (placeholder "-" shown)
      const clearedRow = table.locator("tbody tr").filter({ hasText: TEAM_UNIV });
      await expect(clearedRow.locator(".select-placeholder")).toHaveText("-");
    } finally {
      await removeMapping();
    }
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
    await expect(table.locator("tbody tr")).toHaveCount(8);
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
    await expect(firstNumDesc).toHaveText("32");
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
