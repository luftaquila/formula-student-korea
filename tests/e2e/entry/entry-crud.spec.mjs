import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Entry CRUD operations", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);
  });

  test("renders entry table with seeded data", async ({ page }) => {
    const table = page.locator(".entry-table");
    await expect(table).toBeVisible();

    // Verify all 8 seeded entries are present
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(8);

    // Verify specific seeded entries by their number column
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
    await expect(table.locator("tbody")).toContainText("성균관대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");
    await expect(table.locator("tbody")).toContainText("고려대학교");

    // Verify entry count badge
    await expect(page.locator(".entry-count")).toHaveText("8대");
  });

  test("adds a new entry", async ({ page }) => {
    // Fill the entry form
    const sidebar = page.locator(".sidebar");
    await sidebar.locator('input[type="number"]').fill("99");
    await sidebar.locator('input[type="text"]').first().fill("테스트대학교");
    await sidebar.locator('input[type="text"]').nth(1).fill("테스트팀");
    await sidebar.locator("select.form-input").selectOption("EV");

    // Submit form (use .submit-btn to avoid matching VehicleTypeManager's submit button)
    await sidebar.locator('.submit-btn').click();

    // Verify success notification
    await expectNotification(page, "success", "99번 엔트리를 추가했습니다.");

    // Wait for table to update and verify the new entry
    await waitForPageReady(page);
    const table = page.locator(".entry-table");
    await expect(table.locator("tbody")).toContainText("테스트대학교");
    await expect(table.locator("tbody")).toContainText("테스트팀");
    await expect(page.locator(".entry-count")).toHaveText("9대");

    // Clean up: delete the entry we just added
    const row = table.locator("tbody tr").filter({ hasText: "테스트대학교" });
    page.on("dialog", (dialog) => dialog.accept());
    await row.locator(".btn-danger").click();
    await waitForPageReady(page);
  });

  test("inline edits an entry university name", async ({ page }) => {
    const table = page.locator(".entry-table");

    // Find the row with entry number 10 (KAIST) and click the university cell text
    const row = table.locator("tbody tr").filter({ hasText: "KAIST" });
    await row.locator("td.col-univ .cell-text").click();

    // After clicking, "KAIST" moves from span text to input value,
    // so the row filter no longer matches — find the edit input directly
    const editInput = table.locator("input.edit-input");
    await expect(editInput).toBeVisible();

    // Clear and type new value
    await editInput.fill("카이스트");
    await editInput.press("Enter");

    // 같은 번호에서 학교명이 바뀌면 명칭 정정(데이터 유지)인지 팀 교체(데이터 삭제)인지
    // 묻는 모달이 뜬다. 단순 명칭 정정이므로 "명칭 정정"을 선택한다.
    const modal = page.locator(".ambiguity-modal");
    await expect(modal).toBeVisible();
    await modal.locator(".ambiguity-btn.retain").click();

    // Verify success notification
    await expectNotification(page, "success", "10번 엔트리를 수정했습니다.");

    // Wait for table to update and verify the edit
    await waitForPageReady(page);
    await expect(table.locator("tbody")).toContainText("카이스트");

    // Revert: edit back to original (학교명이 다시 바뀌므로 동일한 모달이 뜬다)
    const updatedRow = table.locator("tbody tr").filter({ hasText: "카이스트" });
    await updatedRow.locator("td.col-univ .cell-text").click();
    const revertInput = table.locator("input.edit-input");
    await expect(revertInput).toBeVisible();
    await revertInput.fill("KAIST");
    await revertInput.press("Enter");
    await expect(modal).toBeVisible();
    await modal.locator(".ambiguity-btn.retain").click();
    await waitForPageReady(page);
  });

  test("deletes an entry", async ({ page }) => {
    // First, add a temporary entry to delete
    const sidebar = page.locator(".sidebar");
    await sidebar.locator('input[type="number"]').fill("88");
    await sidebar.locator('input[type="text"]').first().fill("삭제대학교");
    await sidebar.locator('input[type="text"]').nth(1).fill("삭제팀");
    await sidebar.locator('.submit-btn').click();
    await waitForPageReady(page);
    await expect(page.locator(".entry-count")).toHaveText("9대");

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Find and delete the entry
    const table = page.locator(".entry-table");
    const row = table.locator("tbody tr").filter({ hasText: "삭제대학교" });
    await row.locator(".btn-danger").click();

    // Verify success notification
    await expectNotification(page, "success", "88번 엔트리를 삭제했습니다.");

    // Wait for table to update and verify deletion
    await waitForPageReady(page);
    await expect(table.locator("tbody")).not.toContainText("삭제대학교");
    await expect(page.locator(".entry-count")).toHaveText("8대");
  });

  test("filters entries with search", async ({ page }) => {
    const searchInput = page.locator(".search-input");
    const table = page.locator(".entry-table");

    // Search by university name
    await searchInput.fill("서울");
    const filteredRows = table.locator("tbody tr");
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
    await expect(table.locator("tbody tr")).toHaveCount(8);
  });

  test("sorts entries by column headers", async ({ page }) => {
    const table = page.locator(".entry-table");

    // Default sort is by num ascending (from computed)
    const firstRowNum = table.locator("tbody tr").first().locator(".entry-number");
    await expect(firstRowNum).toHaveText("1");

    // Click "학교" header to sort by university ascending
    await table.locator("th.col-univ").click();
    // Alphabetical order: KAIST < 고려대학교 < 서울대학교 < 성균관대학교 < 한양대학교
    const firstRowAfterUnivSort = table.locator("tbody tr").first().locator("td.col-univ .cell-text");
    await expect(firstRowAfterUnivSort).toHaveText("KAIST");

    // Click again to sort descending
    await table.locator("th.col-univ").click();
    const firstRowAfterUnivDescSort = table.locator("tbody tr").first().locator("td.col-univ .cell-text");
    await expect(firstRowAfterUnivDescSort).toHaveText("한양대학교");

    // Click "번호" header to sort by num ascending
    await table.locator("th.col-num").click();
    const firstRowAfterNumSort = table.locator("tbody tr").first().locator(".entry-number");
    await expect(firstRowAfterNumSort).toHaveText("1");

    // Click again to sort by num descending
    await table.locator("th.col-num").click();
    const firstRowAfterNumDescSort = table.locator("tbody tr").first().locator(".entry-number");
    await expect(firstRowAfterNumDescSort).toHaveText("32");
  });
});
