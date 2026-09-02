import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Documents session CRUD", () => {
  test.use({ storageState: storageStatePath("chief") });

  test("creates, edits, and deletes a session", async ({ page }) => {
    // Navigate to admin dashboard
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    // Verify the dashboard loads with the "세션 생성" button
    const createBtn = page.locator("a").filter({ hasText: "세션 생성" });
    await expect(createBtn).toBeVisible();

    // --- CREATE ---
    await createBtn.click();
    await waitForPageReady(page);

    // Verify the session form page loaded
    await expect(page.locator("h3")).toContainText("세션 생성");

    // Fill the session form
    await page.locator(".session-form .form-input[type='text']").first().fill("E2E CRUD 테스트 세션");
    await page.locator(".session-form .form-textarea").fill("CRUD 테스트용 세션입니다.");

    // Set start date (yesterday)
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const formatLocal = (d) => {
      const offset = d.getTimezoneOffset();
      const local = new Date(d.getTime() - offset * 60000);
      return local.toISOString().slice(0, 16);
    };

    await page.locator("input[type='datetime-local']").nth(0).fill(formatLocal(yesterday));
    await page.locator("input[type='datetime-local']").nth(1).fill(formatLocal(nextWeek));

    // Set allowed extensions
    await page.locator("input[placeholder*='pdf']").fill("pdf, docx");

    // Select teams using "전체 선택" button
    await page.getByRole("button", { name: "전체 선택" }).click();

    // Submit
    await page.getByRole("button", { name: "생성" }).click();

    // Verify success notification
    await expectNotification(page, "success", "세션을 생성했습니다.");
    await waitForPageReady(page);

    // Should redirect to session detail page
    await expect(page.locator("h3").first()).toContainText("E2E CRUD 테스트 세션");

    // --- EDIT ---
    // Click the edit button from session detail page
    const editBtn = page.locator("a").filter({ hasText: "수정" });
    await expect(editBtn).toBeVisible();
    await editBtn.click();
    await waitForPageReady(page);

    // Verify edit form page loaded
    await expect(page.locator("h3")).toContainText("세션 수정");

    // Change the session name
    const nameInput = page.locator(".session-form .form-input[type='text']").first();
    await nameInput.fill("E2E CRUD 수정된 세션");

    // Submit the edit
    await page.getByRole("button", { name: "수정" }).click();

    // Verify success notification
    await expectNotification(page, "success", "세션을 수정했습니다.");
    await waitForPageReady(page);

    // Should redirect back to detail page with updated name
    await expect(page.locator("h3").first()).toContainText("E2E CRUD 수정된 세션");

    // --- DELETE ---
    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Click the delete button
    await page.getByRole("button", { name: "삭제" }).click();

    // Verify success notification
    await expectNotification(page, "success", "세션을 삭제했습니다.");
    await waitForPageReady(page);

    // Should redirect back to admin dashboard
    await expect(page).toHaveURL(/\/documents\/admin/);

    // Verify the deleted session is no longer visible
    await expect(page.locator(".main-table:not([data-table-head-copy]) .session-link").filter({ hasText: "E2E CRUD 수정된 세션" })).not.toBeVisible();
  });
});
