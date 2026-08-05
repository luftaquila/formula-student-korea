import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { createDocumentSession, deleteDocumentSession, submitDocument } from "../helpers/documents.mjs";

const SESSION_NAME = "E2E 이전 제출 격리 세션";

test.describe("Documents admin previous submission display", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;

  test.beforeAll(async ({ browser }) => {
    const chiefCtx = await browser.newContext({ storageState: storageStatePath("chief") });
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    try {
      sessionId = await createDocumentSession(chiefCtx.request, SESSION_NAME, { teams: [1, 2] });
      await submitDocument(studentCtx.request, sessionId, "prev-test-1.pdf");
      await submitDocument(studentCtx.request, sessionId, "prev-test-2.pdf");
    } finally {
      await studentCtx.close();
      await chiefCtx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const chiefCtx = await browser.newContext({ storageState: storageStatePath("chief") });
    try {
      await deleteDocumentSession(chiefCtx.request, sessionId);
    } finally {
      await chiefCtx.close();
    }
  });

  test("shows clickable count cell for team with previous submission", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: SESSION_NAME });
    await sessionLink.click();
    await waitForPageReady(page);

    // Team 1 (서울대학교) now has 2 submissions, so count cell should be clickable
    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    await expect(team1Row.locator(".col-count-expand")).toBeVisible();
  });

  test("clicking count cell shows previous submission details", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: SESSION_NAME });
    await sessionLink.click();
    await waitForPageReady(page);

    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    await team1Row.locator(".col-count-expand").click();

    // Verify the previous submission row appears
    const prevRow = table.locator("tr.row-prev");
    await expect(prevRow).toBeVisible();
    await expect(prevRow.locator(".prev-label")).toContainText("이전 제출");
    await expect(prevRow.locator(".file-link").first()).toBeVisible();
  });

  test("clicking count cell again hides previous submission", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: SESSION_NAME });
    await sessionLink.click();
    await waitForPageReady(page);

    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    const expandCell = team1Row.locator(".col-count-expand");

    await expandCell.click();
    await expect(table.locator("tr.row-prev")).toBeVisible();

    await expandCell.click();
    await expect(table.locator("tr.row-prev")).not.toBeVisible();
  });

  test("team without previous submission has no expand toggle", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: SESSION_NAME });
    await sessionLink.click();
    await waitForPageReady(page);

    // Team 2 (한양대학교) has no submission at all
    const table = page.locator(".detail-table");
    const team2Row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(team2Row.locator(".col-count-expand")).not.toBeVisible();
  });
});
