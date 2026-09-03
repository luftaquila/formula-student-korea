import { test, expect } from "@playwright/test";
import { storageStatePath, expectNotification, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

const TEST_EMAIL = "e2e-test-user@example.com";
const usersTable = (page) => page.locator("table.users-table");
const userRow = (page, email) => usersTable(page).locator("tbody tr").filter({ hasText: email });

test.describe("User management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);
  });

  test("user list table renders with seeded users", async ({ page }) => {
    const table = usersTable(page);
    await expect(table).toBeVisible();

    // Verify table headers
    await expect(table.locator("th").filter({ hasText: "이메일" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "역할" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "실명" })).toBeVisible();
    await expect(table.locator("th").filter({ hasText: "학교/팀" })).toBeVisible();

    // Verify seeded users appear in the table
    await expect(table.getByRole("cell", { name: "e2e-admin@test.com", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "e2e-chief@test.com", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "e2e-official@test.com", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "e2e-staff@test.com", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "e2e-student@test.com", exact: true })).toBeVisible();
  });

  test("applicant URL is shown next to the 계정 신청 관리 button", async ({ page }) => {
    const chip = page.locator(".apply-url");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("/auth/apply");
  });

  test("add a new user", async ({ page }) => {
    // Fill in email
    await page.locator(".add-form input[type='email']").fill(TEST_EMAIL);

    // Select role
    await page.locator(".add-form select.form-select").selectOption("student");

    // Submit
    await page.locator(".add-form button[type='submit']").click();

    // Verify success notification
    await expectNotification(page, "success", "사용자를 추가했습니다");

    // Verify the new user appears in the table
    await expect(usersTable(page).getByRole("cell", { name: TEST_EMAIL, exact: true })).toBeVisible();
  });

  test("change a user role", async ({ page }) => {
    // Find the row with the test user
    const row = userRow(page, TEST_EMAIL);
    await expect(row).toBeVisible();

    // Accept the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Change role via the action column role select
    await row.locator("select.role-select").selectOption("official");

    // Verify success notification
    await expectNotification(page, "success", "역할을 변경했습니다");

    // Verify the role badge updated
    await expect(row.locator(".badge").filter({ hasText: "official" })).toBeVisible();
  });

  test("edit realname inline", async ({ page }) => {
    const row = userRow(page, TEST_EMAIL);
    await expect(row).toBeVisible();

    // Click the realname cell to start editing
    await row.locator(".col-realname.inline-edit-cell").click();

    // Type into the realname input
    const realnameInput = row.locator(".col-realname .inline-edit-input");
    await expect(realnameInput).toBeVisible();
    await realnameInput.fill("E2E 테스트 실명");

    // Blur to save (press Enter triggers blur)
    await realnameInput.press("Enter");

    // Wait for save to complete, then verify the text persists
    await expect(row.locator(".col-realname .inline-edit-text")).toHaveText("E2E 테스트 실명");
  });

  test("edit affiliation inline", async ({ page }) => {
    const row = userRow(page, TEST_EMAIL);
    await expect(row).toBeVisible();

    // Click the affiliation cell to start editing
    await row.locator(".col-affiliation.inline-edit-cell").click();

    const affiliationInput = row.locator(".col-affiliation .inline-edit-input");
    await expect(affiliationInput).toBeVisible();
    await affiliationInput.fill("E2E대학교 FSAE");

    // Enter triggers blur → save
    await affiliationInput.press("Enter");

    await expect(row.locator(".col-affiliation .inline-edit-text")).toHaveText("E2E대학교 FSAE");
  });

  test("deactivate and activate user", async ({ page }) => {
    const row = userRow(page, TEST_EMAIL);
    await expect(row).toBeVisible();

    // Accept all confirm dialogs
    page.on("dialog", (dialog) => dialog.accept());

    // Click deactivate button
    await row.getByRole("button", { name: "비활성화" }).click();
    await expectNotification(page, "success", "비활성화했습니다");

    // Row should now have inactive styling
    const inactiveRow = usersTable(page).locator("tbody tr.row-inactive").filter({ hasText: TEST_EMAIL });
    await expect(inactiveRow).toBeVisible();

    // Click activate button
    await inactiveRow.getByRole("button", { name: "활성화" }).click();
    await expectNotification(page, "success", "활성화했습니다");

    // Row should no longer be inactive
    const activeRow = userRow(page, TEST_EMAIL);
    await expect(activeRow).toBeVisible();
    await expect(activeRow).not.toHaveClass(/row-inactive/);
  });

  test("delete a user", async ({ page }) => {
    const row = userRow(page, TEST_EMAIL);
    await expect(row).toBeVisible();

    // Accept the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Click delete button
    await row.getByRole("button", { name: "삭제" }).click();

    // Verify success notification
    await expectNotification(page, "success", "사용자를 삭제했습니다");

    // Verify user is removed from the table
    await expect(usersTable(page).getByRole("cell", { name: TEST_EMAIL, exact: true })).not.toBeVisible();
  });
});
