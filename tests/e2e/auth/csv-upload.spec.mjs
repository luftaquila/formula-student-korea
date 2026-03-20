import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const CSV_EMAILS = ["e2e-csv1@test.com", "e2e-csv2@test.com", "e2e-csv3@test.com"];

test.describe("Auth CSV user bulk upload via UI", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async () => {
    // Cleanup: delete CSV test users
    const res = await fetch(`${BASE_URL}/auth/api/users`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const users = await res.json();
    const ids = users.filter((u) => CSV_EMAILS.includes(u.email)).map((u) => u.id);
    if (ids.length > 0) {
      await fetch(`${BASE_URL}/auth/api/users/bulk`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
        body: JSON.stringify({ ids }),
      });
    }
  });

  test("CSV file upload parses and adds users", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    // Prepare CSV content: header row + 3 users + 1 duplicate (existing admin)
    const csvContent = [
      "email,name,role,memo",
      "e2e-csv1@test.com,CSV User 1,student,csv test memo",
      "e2e-csv2@test.com,CSV User 2,official,",
      "e2e-csv3@test.com,CSV User 3,,",
      "e2e-admin@test.com,Duplicate Admin,admin,should be skipped",
    ].join("\n");

    // The uploadCSV function creates a dynamic file input.
    // We intercept the file chooser event when the CSV upload button is clicked.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "CSV 업로드" }).click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles({
      name: "test-users.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });

    // Verify success notification with counts (3 added, 1 skipped)
    await expectNotification(page, "success", "3명 추가");

    // Verify the new users appear in the table
    for (const email of CSV_EMAILS) {
      await expect(page.locator("td").filter({ hasText: email })).toBeVisible();
    }
  });

  test("CSV with quoted fields and commas parses correctly", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    // CSV with quoted fields containing commas
    const csvContent = [
      "email,name,role,memo",
      '"e2e-csv1@test.com","Already Exists","student","memo with, comma"',
    ].join("\n");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "CSV 업로드" }).click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles({
      name: "quoted-users.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });

    // User already exists from prior test, so it should be skipped
    await expectNotification(page, "success", "1명 중복");
  });

  test("empty CSV shows error notification", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);

    const csvContent = "";

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "CSV 업로드" }).click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles({
      name: "empty.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });

    await expectNotification(page, "error", "CSV 파일이 비어있습니다");
  });
});
