import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";

const YEAR = currentCompetitionYear();
const NEXT_YEAR = YEAR + 1;

test.describe("Entry team management", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);
  });

  test("renders entry table with seeded data", async ({ page }) => {
    const table = page.locator(".entry-table:not([data-table-head-copy])");
    await expect(table).toBeVisible();

    // All seeded entries remain present. Other tests may leave deactivated
    // audit rows because teams are intentionally never deleted.
    const rows = table.locator("tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(8);

    // Verify specific seeded entries by their number column
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
    await expect(table.locator("tbody")).toContainText("성균관대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");
    await expect(table.locator("tbody")).toContainText("고려대학교");

    // Verify entry count badge
    await expect(page.locator(".entry-count")).toHaveText(/\d+대/);
  });

  test("defaults to the current year and offers next-year roster preparation", async ({ page }) => {
    const yearSelect = page.locator(".year-select");
    await expect(yearSelect).toHaveValue(String(YEAR));
    await expect(yearSelect.locator(`option[value="${NEXT_YEAR}"]`)).toHaveCount(1);
    const yearOptions = await yearSelect.locator("option").evaluateAll((options) => (
      options.map((option) => Number(option.value))
    ));
    expect(yearOptions).toEqual([...yearOptions].sort((a, b) => b - a));

    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/teams?includeInactive=true&year=${NEXT_YEAR}`)),
      page.waitForResponse((response) => response.url().includes(`/vehicle-types?year=${NEXT_YEAR}`)),
      yearSelect.selectOption(String(NEXT_YEAR)),
    ]);

    await expect(page.locator(".roster-editor")).toBeEnabled();
  });

  test("keeps editing disabled when either dataset for a newly selected year fails", async ({ page }) => {
    let releaseEntries;
    let releaseVehicleTypes;
    let markEntriesRequested;
    let markVehicleTypesRequested;
    const entriesGate = new Promise((resolve) => { releaseEntries = resolve; });
    const vehicleTypesGate = new Promise((resolve) => { releaseVehicleTypes = resolve; });
    const entriesRequested = new Promise((resolve) => { markEntriesRequested = resolve; });
    const vehicleTypesRequested = new Promise((resolve) => { markVehicleTypesRequested = resolve; });
    const entriesPattern = `**/competition/api/v1/teams?includeInactive=true&year=${NEXT_YEAR}`;
    const vehicleTypesPattern = `**/competition/api/v1/vehicle-types?year=${NEXT_YEAR}`;

    await page.route(entriesPattern, async (route) => {
      markEntriesRequested();
      await entriesGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route(vehicleTypesPattern, async (route) => {
      markVehicleTypesRequested();
      await vehicleTypesGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "vehicle type load failed" }),
      });
    });

    await page.locator(".year-select").selectOption(String(NEXT_YEAR));
    await Promise.all([entriesRequested, vehicleTypesRequested]);
    await expect(page.locator(".roster-editor")).toBeDisabled();
    await expect(page.locator(".entry-table:not([data-table-head-copy])")).not.toBeVisible();

    releaseEntries();
    await expect(page.locator(".entry-table:not([data-table-head-copy])")).toBeVisible();
    await expect(page.locator(".roster-editor")).toBeDisabled();

    releaseVehicleTypes();
    await expectNotification(page, "error", "vehicle type load failed");
    await expect(page.locator(".roster-editor")).toBeDisabled();
  });

  test("adds a new entry", async ({ page }) => {
    const number = 90000 + (Date.now() % 9999);
    const university = `테스트대학교-${number}`;

    // Fill the entry form
    const sidebar = page.locator(".sidebar");
    await sidebar.locator('input[type="number"]').fill(String(number));
    await sidebar.locator('input[type="text"]').first().fill(university);
    await sidebar.locator('input[type="text"]').nth(1).fill("테스트팀");
    await sidebar.locator("select.form-input").selectOption("EV");

    // Submit form (use .submit-btn to avoid matching VehicleTypeManager's submit button)
    await sidebar.locator('.submit-btn').click();

    // Verify success notification
    await expectNotification(page, "success", `${number}번 엔트리를 추가했습니다.`);

    // Wait for table to update and verify the new entry
    await waitForPageReady(page);
    const table = page.locator(".entry-table:not([data-table-head-copy])");
    await expect(table.locator("tbody")).toContainText(university);
    await expect(table.locator("tbody")).toContainText("테스트팀");

    // Teams are retained for audit. Deactivate the temporary team so it cannot
    // affect operational modules or later active-team assertions.
    const row = table.locator("tbody tr").filter({ hasText: university });
    page.on("dialog", (dialog) => dialog.accept());
    await row.locator(".status-toggle").click();
    await expect(row).toHaveClass(/entry-inactive/);
  });

  test("inline edits an entry university name", async ({ page }) => {
    const table = page.locator(".entry-table:not([data-table-head-copy])");

    // Find the row with entry number 10 (KAIST) and click the desktop university cell.
    const row = table.locator("tbody tr").filter({ hasText: "KAIST" });
    await row.locator("td.col-univ .cell-text").click();

    // After clicking, "KAIST" moves from span text to input value,
    // so the row filter no longer matches — find the edit input directly
    const editInput = table.locator("input.edit-input:visible");
    await expect(editInput).toBeVisible();

    // Clear and type new value
    await editInput.fill("카이스트");
    await editInput.press("Enter");

    // Verify success notification
    await expectNotification(page, "success", "10번 엔트리를 수정했습니다.");

    // Wait for table to update and verify the edit
    await waitForPageReady(page);
    await expect(table.locator("tbody")).toContainText("카이스트");

    // Revert: edit back to original.
    const updatedRow = table.locator("tbody tr").filter({ hasText: "카이스트" });
    await updatedRow.locator("td.col-univ .cell-text").click();
    const revertInput = table.locator("input.edit-input:visible");
    await expect(revertInput).toBeVisible();
    await revertInput.fill("KAIST");
    await revertInput.press("Enter");
    await waitForPageReady(page);
  });

  test("deactivates an entry without deleting its stable row", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());

    const table = page.locator(".entry-table:not([data-table-head-copy])");
    const row = table.locator("tbody tr").filter({ hasText: "고려대학교" });
    const toggle = row.locator(".status-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();

    await expectNotification(page, "success", "20번 엔트리를 비활성화했습니다.");
    await expect(row).toHaveClass(/entry-inactive/);
    await expect(row).toContainText("고려대학교");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Restore the seeded team's active state for downstream suites.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("filters entries with search", async ({ page }) => {
    const searchInput = page.locator(".search-input");
    const table = page.locator(".entry-table:not([data-table-head-copy])");

    // Search by university name. "adds a new entry" retains a deactivated
    // 테스트대학교-9xxxx row for audit, and its number can contain the digits
    // searched below, so count only the seeded rows.
    await searchInput.fill("서울");
    const filteredRows = table.locator("tbody tr").filter({ hasNotText: "테스트대학교" });
    await expect(filteredRows).toHaveCount(1);
    await expect(filteredRows.first()).toContainText("서울대학교");

    // Search by team name
    await searchInput.fill("ACES");
    await expect(filteredRows).toHaveCount(1);
    await expect(filteredRows.first()).toContainText("한양대학교");

    // Search by entry number
    await searchInput.fill("20");
    await expect(filteredRows).toHaveCount(1);
    await expect(filteredRows.first()).toContainText("고려대학교");

    // Search by vehicle type
    await searchInput.fill("CV");
    await expect(filteredRows).toHaveCount(3);

    // Search with no results
    await searchInput.fill("존재하지않는대학");
    await expect(table.locator("tbody")).toContainText("등록된 엔트리가 없습니다");

    // Clear search to restore all entries
    await searchInput.fill("");
    await expect(table.locator("tbody")).toContainText("서울대학교");
  });

  test("sorts entries by the desktop column headers", async ({ page }) => {
    const table = page.locator(".entry-table:not([data-table-head-copy])");
    const universityHeader = table.locator("th.col-univ");
    const numberHeader = table.locator("th.col-num");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

    // Default sort is by num ascending (from computed)
    const firstRowNum = table.locator("tbody tr").first().locator(".entry-number");
    await expect(firstRowNum).toHaveText("1");
    await expect(table.locator("th[aria-sort]")).toHaveCount(0);

    await universityHeader.evaluate((element) => element.click());
    await expect(universityHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(table.locator("th[aria-sort]")).toHaveCount(1);
    await expect(table.locator("tbody tr").first().locator("td.col-univ .cell-text")).toHaveText("KAIST");

    await universityHeader.evaluate((element) => element.click());
    await expect(universityHeader).toHaveAttribute("aria-sort", "descending");
    await expect(table.locator("tbody tr").first().locator("td.col-univ .cell-text")).toHaveText("한양대학교");

    await numberHeader.evaluate((element) => element.click());
    await expect(numberHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(universityHeader).not.toHaveAttribute("aria-sort", /.+/);
    await expect(table.locator("th[aria-sort]")).toHaveCount(1);
    await expect(table.locator("tbody tr").first().locator(".entry-number")).toHaveText("1");

    await numberHeader.evaluate((element) => element.click());
    await expect(numberHeader).toHaveAttribute("aria-sort", "descending");
    const numbers = await table.locator("tbody tr .entry-number").allTextContents();
    const numeric = numbers.map(Number);
    expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
  });
});
