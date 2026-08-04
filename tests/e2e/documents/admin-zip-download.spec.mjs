import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { PDF_CONTENT, createDocumentSession, deleteDocumentSession } from "../helpers/documents.mjs";

const SESSION_NAME = "E2E ZIP 다운로드 격리 세션";

test.describe("Documents admin zip download", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;
  let submissionId;

  test.beforeAll(async ({ browser }) => {
    const chiefCtx = await browser.newContext({ storageState: storageStatePath("chief") });
    try {
      sessionId = await createDocumentSession(chiefCtx.request, SESSION_NAME);
    } finally {
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

  test("submit multiple files and verify zip download link", async ({ page, browser }) => {
    // Submit 2 files as student
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto("/documents");
    await waitForPageReady(studentPage);

    const sessionCard = studentPage.locator(".session-card").filter({ hasText: SESSION_NAME });
    await sessionCard.click();
    await waitForPageReady(studentPage);

    // Accept resubmission confirm dialog
    studentPage.on("dialog", (dialog) => dialog.accept());

    // Upload two files at once
    const fileInput = studentPage.locator("input[type='file']");
    await fileInput.setInputFiles([
      { name: "zip-test-1.pdf", mimeType: "application/pdf", buffer: PDF_CONTENT },
      { name: "zip-test-2.pdf", mimeType: "application/pdf", buffer: PDF_CONTENT },
    ]);

    await expect(studentPage.locator(".selected-file")).toHaveCount(2);
    await studentPage.getByRole("button", { name: "제출" }).click();
    await expectNotification(studentPage, "success", "제출 완료");
    await waitForPageReady(studentPage);

    // Get the submission ID for the isolated session.
    const detailRes = await studentPage.request.get(`/documents/api/sessions/${sessionId}`);
    const detail = await detailRes.json();
    submissionId = detail.submission.id;

    await studentPage.close();
    await studentCtx.close();

    // Verify admin view shows zip download link immediately after submit
    // (no gap for parallel tests to overwrite the 2-file submission)
    await page.goto("/documents/admin", { waitUntil: "networkidle" });

    const sessionLink = page.locator(".session-link").filter({ hasText: SESSION_NAME });
    const statusResp = page.waitForResponse((res) => res.url().includes("/api/admin/sessions/") && res.url().includes("/status") && res.status() === 200);
    await sessionLink.click();
    await statusResp;

    const table = page.locator(".detail-table");
    await table.waitFor({ state: "visible" });
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();

    // Verify zip download link is present
    const zipLink = team1Row.locator(".file-zip");
    await expect(zipLink).toBeVisible();
    await expect(zipLink).toContainText("전체 다운로드");
  });

  test("admin can download zip via API", async ({ page }) => {
    const zipRes = await page.request.get(`/documents/api/admin/submissions/${submissionId}/zip`);
    expect(zipRes.status()).toBe(200);
    expect(zipRes.headers()["content-type"]).toBe("application/zip");
    const disposition = decodeURIComponent(zipRes.headers()["content-disposition"]);
    expect(disposition).toContain(".zip");
    expect(disposition).toContain("E2E");
    expect(disposition).toMatch(/\d+/); // team_num

    const body = await zipRes.body();
    expect(body.length).toBeGreaterThan(0);
  });

  test("zip download link not visible for single file submissions", async ({ browser }) => {
    // Resubmit with a single file via UI
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto("/documents", { waitUntil: "networkidle" });

    const sessionCard = studentPage.locator(".session-card").filter({ hasText: SESSION_NAME });
    await sessionCard.click();
    await waitForPageReady(studentPage);

    studentPage.on("dialog", (dialog) => dialog.accept());

    const fileInput = studentPage.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "zip-test-single.pdf",
      mimeType: "application/pdf",
      buffer: PDF_CONTENT,
    });

    await studentPage.getByRole("button", { name: "제출" }).click();
    await expectNotification(studentPage, "success", "제출 완료");

    await studentPage.close();
    await studentCtx.close();

    // Check admin view — single file should not show zip link
    const chiefCtx = await browser.newContext({
      storageState: storageStatePath("chief"),
    });
    const chiefPage = await chiefCtx.newPage();
    await chiefPage.goto("/documents/admin", { waitUntil: "networkidle" });

    const sessionLink = chiefPage.locator(".session-link").filter({ hasText: SESSION_NAME });
    const statusResp = chiefPage.waitForResponse((res) => res.url().includes("/api/admin/sessions/") && res.url().includes("/status") && res.status() === 200);
    await sessionLink.click();
    await statusResp;

    const table = chiefPage.locator(".detail-table");
    await table.waitFor({ state: "visible" });
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    await expect(team1Row.locator(".file-zip")).not.toBeVisible();

    await chiefPage.close();
    await chiefCtx.close();
  });
});
