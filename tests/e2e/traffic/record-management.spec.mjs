import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Traffic record management", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed a record via API before tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create a record by POSTing via the API
    const response = await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Records",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 5432,
          detail: "e2e test record",
        },
      },
    });
    expect(response.status()).toBe(201);

    // Add a second record for completeness
    const response2 = await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Records",
        data: {
          time: new Date().toISOString(),
          type: "오토크로스",
          entry: { num: 2, univ: "한양대학교", team: "ACES" },
          result: 12345,
          detail: "e2e autocross record",
        },
      },
    });
    expect(response2.status()).toBe(201);

    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);
  });

  test("selects a record file and renders table", async ({ page }) => {
    // Select the record file we seeded
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    // Wait for table to render
    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Verify table has rows
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(2);

    // Verify record content
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("한양대학교");
  });

  test("inline edits cone touch penalty", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click on the cone touch cell of the first record
    const firstRow = table.locator("tbody tr").first();
    const conesCell = firstRow.locator(".penalty-cell").first();
    await conesCell.click();

    // Edit the cone touch value
    const conesInput = conesCell.locator(".penalty-input");
    await expect(conesInput).toBeVisible();
    await conesInput.fill("3");
    await conesInput.press("Enter");

    // Wait for update to complete
    await page.waitForTimeout(500);

    // Verify the value was updated
    await expect(conesCell.locator(".penalty-text")).toHaveText("3");
  });

  test("inline edits off-course penalty", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click on the off-course cell of the first record
    const firstRow = table.locator("tbody tr").first();
    const ocCell = firstRow.locator(".penalty-cell").nth(1);
    await ocCell.click();

    // Edit the off-course value
    const ocInput = ocCell.locator(".penalty-input");
    await expect(ocInput).toBeVisible();
    await ocInput.fill("1");
    await ocInput.press("Enter");

    // Wait for update to complete
    await page.waitForTimeout(500);

    // Verify the value was updated
    await expect(ocCell.locator(".penalty-text")).toHaveText("1");
  });

  test("toggles invalidation on a record", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click invalidate button on the second record
    const secondRow = table.locator("tbody tr").nth(1);
    const invalidateBtn = secondRow.locator(".btn-invalidate");
    await invalidateBtn.click();

    // Row should now have is-invalidated class
    await expect(secondRow).toHaveClass(/is-invalidated/);

    // Toggle it back (restore)
    await invalidateBtn.click();

    // Row should no longer have is-invalidated class
    await expect(secondRow).not.toHaveClass(/is-invalidated/);
  });

  test("adds a manual record via the add form", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click the "기록 추가" button
    const addBtn = page.locator("button.btn-primary", { hasText: "기록 추가" });
    await addBtn.click();

    // Fill the add form
    const addForm = page.locator(".add-form");
    await expect(addForm).toBeVisible();

    // Select event type
    await addForm.locator(".form-select").first().selectOption("스키드패드");

    // Select entry
    await addForm.locator(".form-select").nth(1).selectOption("3");

    // Enter result in ms
    await addForm.locator('.form-input[type="number"]').fill("8765");

    // Submit
    await addForm.locator("button.add-form-submit").click();

    // Verify success notification
    await expectNotification(page, "success", "기록이 추가되었습니다");

    // Verify new record appears in table
    await page.waitForTimeout(500);
    await expect(table.locator("tbody")).toContainText("성균관대학교");
  });

  // Clean up the seeded record file after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/traffic/api/records/FSK ${YEAR} E2E-Records`);
    await context.close();
  });
});
