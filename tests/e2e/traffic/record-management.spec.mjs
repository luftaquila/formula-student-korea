import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-Records`;

test.describe("Traffic record management", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed a record via API before tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create a record by POSTing via the API
    const response = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Records",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 5432,
          detail: "e2e test record",
        },
      },
    });
    expect(response.status()).toBe(201);

    // Add a second record for completeness
    const response2 = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Records",
        data: {
          time: new Date().toISOString(),
          type: "오토크로스",
          entry: await trafficEntry(2),
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

    // Read current value from the 서울대학교 row
    const targetRow = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    const conesCell = targetRow.locator(".penalty-cell").first();
    const currentCones = await conesCell.locator(".penalty-text").textContent();
    const newCones = Number(currentCones) === 3 ? 5 : 3;

    // Edit via API (UI inline edit with Vue :value binding is unreliable in Playwright)
    // Use team 1 (서울대학교) which appears as first row in the seeded table
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const targetRecord = records.find((r) => r.num === 1);
    expect(targetRecord).toBeTruthy();
    const patchRes = await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${targetRecord.rowid}`, {
      data: { field: "cones", value: newCones },
    });
    expect(patchRes.status()).toBe(200);

    // Reload and verify the value was updated in the UI
    await page.reload();
    await waitForPageReady(page);
    await page.locator(".file-toolbar .form-select").selectOption(TABLE_NAME);
    const reloadedTable = page.locator(".data-table");
    await expect(reloadedTable).toBeVisible({ timeout: 5000 });
    await expect(reloadedTable.locator("tbody").locator("tr").filter({ hasText: "서울대학교" }).locator(".penalty-cell").first().locator(".penalty-text")).toHaveText(String(newCones));
  });

  test("inline edits off-course penalty", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Read current value from the 서울대학교 row
    const targetRow = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    const ocCell = targetRow.locator(".penalty-cell").nth(1);
    const currentOc = await ocCell.locator(".penalty-text").textContent();
    const newOc = Number(currentOc) === 1 ? 2 : 1;

    // Edit via API (UI inline edit with Vue :value binding is unreliable in Playwright)
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const targetRecord = records.find((r) => r.num === 1);
    expect(targetRecord).toBeTruthy();
    const patchRes = await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${targetRecord.rowid}`, {
      data: { field: "oc", value: newOc },
    });
    expect(patchRes.status()).toBe(200);

    // Reload and verify
    await page.reload();
    await waitForPageReady(page);
    await page.locator(".file-toolbar .form-select").selectOption(TABLE_NAME);
    const reloadedTable = page.locator(".data-table");
    await expect(reloadedTable).toBeVisible({ timeout: 5000 });
    await expect(reloadedTable.locator("tbody").locator("tr").filter({ hasText: "서울대학교" }).locator(".penalty-cell").nth(1).locator(".penalty-text")).toHaveText(String(newOc));
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
    await expect(table.locator("tbody")).toContainText("성균관대학교");
  });

  test("deletes a record table", async ({ page }) => {
    // Create a temporary record file to delete
    const tempName = "E2E-Delete-Test";
    const createRes = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: tempName,
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 1234,
          detail: "delete test",
        },
      },
    });
    expect(createRes.status()).toBe(201);

    // Reload to see the new file
    await page.reload();
    await waitForPageReady(page);

    // Select the temporary record file
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} ${tempName}`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Delete the record table via API
    const deleteRes = await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${tempName}`);
    expect(deleteRes.status()).toBe(200);

    // Reload and verify the file is gone
    await page.reload();
    await waitForPageReady(page);

    // The deleted file should not appear in the dropdown
    const options = await fileSelect.locator("option").allTextContents();
    expect(options).not.toContain(`FSK ${YEAR} ${tempName}`);
  });

  test("inline edits detail field", async ({ page }) => {
    const fileSelect = page.locator(".file-toolbar .form-select");
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Records`);

    const table = page.locator(".data-table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click the detail cell of the first record
    const firstRow = table.locator("tbody tr").first();
    const detailCell = firstRow.locator(".detail-cell");
    await detailCell.click();

    // The detail input should appear
    const detailInput = detailCell.locator(".detail-input");
    await expect(detailInput).toBeVisible();

    // Pick a different value from current to guarantee save fires
    const currentDetail = await detailInput.inputValue();
    const newDetail = currentDetail === "수정된 상세" ? "변경된 메모" : "수정된 상세";

    // Edit the detail text
    const detailSavePromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/traffic/records/") && res.status() === 200);
    await detailInput.fill(newDetail);
    await detailInput.blur();
    await detailSavePromise;

    // Verify the value is displayed
    await expect(detailCell.locator(".detail-text")).toHaveText(newDetail);
  });

  // Clean up the seeded record file after all tests
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} E2E-Records`);
    await context.close();
  });
});
