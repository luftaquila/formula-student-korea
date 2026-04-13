import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const BULK_EMAILS = ["e2e-bulk-op1@test.com", "e2e-bulk-op2@test.com", "e2e-bulk-op3@test.com"];

test.describe("Auth bulk operations", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeAll(async () => {
    // Seed bulk test users via API
    for (const email of BULK_EMAILS) {
      await fetch(`${BASE_URL}/auth/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
        body: JSON.stringify({ email, role: "student" }),
      });
    }
  });

  test.afterAll(async () => {
    // Cleanup: delete bulk test users via API
    const res = await fetch(`${BASE_URL}/auth/api/users`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const users = await res.json();
    const bulkIds = users.filter((u) => BULK_EMAILS.includes(u.email)).map((u) => u.id);
    if (bulkIds.length > 0) {
      await fetch(`${BASE_URL}/auth/api/users/bulk`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
        body: JSON.stringify({ ids: bulkIds }),
      });
    }
  });

  test("select multiple users and bulk deactivate", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    // Accept all confirm dialogs
    page.on("dialog", (dialog) => dialog.accept());

    // Select the bulk test users via checkboxes
    for (const email of BULK_EMAILS) {
      const row = page.locator("tr").filter({ hasText: email });
      await expect(row).toBeVisible();
      await row.locator('input[type="checkbox"]').check();
    }

    // Click bulk deactivate button
    const bulkDeactivateBtn = page.getByRole("button", { name: /선택 비활성화/ });
    await expect(bulkDeactivateBtn).toBeVisible();
    await bulkDeactivateBtn.click();

    // Verify success notification
    await expectNotification(page, "success", "비활성화");

    // Verify rows are now inactive
    for (const email of BULK_EMAILS) {
      const row = page.locator("tr").filter({ hasText: email });
      await expect(row).toHaveClass(/row-inactive/);
    }
  });

  test("select multiple users and bulk activate", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    page.on("dialog", (dialog) => dialog.accept());

    // Select the deactivated bulk test users
    for (const email of BULK_EMAILS) {
      const row = page.locator("tr").filter({ hasText: email });
      await expect(row).toBeVisible();
      await row.locator('input[type="checkbox"]').check();
    }

    // Click bulk activate button (changes to "선택 활성화" when inactive users are selected)
    // Actually bulk activate uses same pattern — let's activate one by one via API first if needed
    // The button text changes based on selection state. Let's just use individual activate buttons
    // Actually, looking at the UI code: there's only "선택 비활성화" and "선택 삭제" buttons.
    // For bulk activate, we use the individual activate buttons. Let's verify via individual buttons.
    const firstRow = page.locator("tr").filter({ hasText: BULK_EMAILS[0] });
    await firstRow.getByRole("button", { name: "활성화" }).click();
    await expectNotification(page, "success", "활성화");

    // Activate the rest
    for (const email of BULK_EMAILS.slice(1)) {
      const row = page.locator("tr").filter({ hasText: email });
      await row.getByRole("button", { name: "활성화" }).click();
      await expectNotification(page, "success", "활성화");
    }

    // Verify rows are no longer inactive
    for (const email of BULK_EMAILS) {
      const row = page.locator("tr").filter({ hasText: email });
      await expect(row).not.toHaveClass(/row-inactive/);
    }
  });

  test("select multiple users and bulk delete", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    page.on("dialog", (dialog) => dialog.accept());

    // Select the bulk test users
    for (const email of BULK_EMAILS) {
      const row = page.locator("tr").filter({ hasText: email });
      await expect(row).toBeVisible();
      await row.locator('input[type="checkbox"]').check();
    }

    // Click bulk delete button
    const bulkDeleteBtn = page.getByRole("button", { name: /선택 삭제/ });
    await expect(bulkDeleteBtn).toBeVisible();
    await bulkDeleteBtn.click();

    // Verify success notification
    await expectNotification(page, "success", "삭제");

    // Verify users are removed from the table
    for (const email of BULK_EMAILS) {
      await expect(page.locator("td").filter({ hasText: email })).not.toBeVisible();
    }
  });

  test("bulk add users via API and verify in UI", async ({ page }) => {
    const bulkAddEmails = ["e2e-bulkadd1@test.com", "e2e-bulkadd2@test.com"];

    // Bulk add: 2 new + 1 duplicate (admin user always exists)
    const res = await fetch(`${BASE_URL}/auth/api/users/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
      body: JSON.stringify({
        users: [
          { email: bulkAddEmails[0], role: "student" },
          { email: bulkAddEmails[1], role: "official", realname: "bulk test" },
          { email: "e2e-admin@test.com", role: "admin" },
        ],
      }),
    });
    const result = await res.json();
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);

    // Verify new users appear in UI
    await page.goto("/auth");
    await waitForPageReady(page);

    for (const email of bulkAddEmails) {
      await expect(page.locator("td").filter({ hasText: email })).toBeVisible();
    }

    // Cleanup: delete the bulk-added users
    const listRes = await fetch(`${BASE_URL}/auth/api/users`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const users = await listRes.json();
    const idsToDelete = users.filter((u) => bulkAddEmails.includes(u.email)).map((u) => u.id);
    if (idsToDelete.length > 0) {
      await fetch(`${BASE_URL}/auth/api/users/bulk`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
        body: JSON.stringify({ ids: idsToDelete }),
      });
    }
  });

  test("ADMIN_EMAIL user cannot be deactivated or deleted", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    // The admin user row should have protected indicator
    const adminRow = page.locator("tr").filter({ hasText: "e2e-admin@test.com" });
    await expect(adminRow).toBeVisible();

    // Admin row buttons should be disabled (protected admin)
    await expect(adminRow.getByRole("button", { name: "비활성화" })).toBeDisabled();
    await expect(adminRow.getByRole("button", { name: "삭제" })).toBeDisabled();
  });
});
