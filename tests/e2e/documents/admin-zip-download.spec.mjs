import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const pdfContent = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

test.describe("Documents admin zip download", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;
  let submissionId;

  test("submit multiple files via student UI", async ({ browser }) => {
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto("/documents");
    await waitForPageReady(studentPage);

    const sessionCard = studentPage.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(studentPage);

    // Accept resubmission confirm dialog
    studentPage.on("dialog", (dialog) => dialog.accept());

    // Upload two files at once
    const fileInput = studentPage.locator("input[type='file']");
    await fileInput.setInputFiles([
      { name: "zip-test-1.pdf", mimeType: "application/pdf", buffer: pdfContent },
      { name: "zip-test-2.pdf", mimeType: "application/pdf", buffer: pdfContent },
    ]);

    await expect(studentPage.locator(".selected-file")).toHaveCount(2);
    await studentPage.getByRole("button", { name: "제출" }).click();
    await expectNotification(studentPage, "success", "제출 완료");
    await waitForPageReady(studentPage);

    // Get submission ID via API
    const sessionsRes = await studentPage.request.get("/documents/api/sessions");
    const sessionsData = await sessionsRes.json();
    const session = sessionsData.sessions.find((s) => s.name === "E2E 테스트 세션");
    sessionId = session.id;

    const detailRes = await studentPage.request.get(`/documents/api/sessions/${sessionId}`);
    const detail = await detailRes.json();
    submissionId = detail.submission.id;

    await studentPage.close();
    await studentCtx.close();
  });

  test("zip download link visible when multiple files exist", async ({ page }) => {
    await page.goto("/documents/admin", { waitUntil: "networkidle" });

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    const table = page.locator(".detail-table");
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

    const sessionCard = studentPage.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(studentPage);

    studentPage.on("dialog", (dialog) => dialog.accept());

    const fileInput = studentPage.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "zip-test-single.pdf",
      mimeType: "application/pdf",
      buffer: pdfContent,
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

    const sessionLink = chiefPage.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(chiefPage);

    const table = chiefPage.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    await expect(team1Row.locator(".file-zip")).not.toBeVisible();

    await chiefPage.close();
    await chiefCtx.close();
  });

  test("restore single file submission for other tests", async ({ browser }) => {
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto("/documents");
    await waitForPageReady(studentPage);

    const sessionCard = studentPage.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(studentPage);

    studentPage.on("dialog", (dialog) => dialog.accept());

    const fileInput = studentPage.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "e2e-test-document.pdf",
      mimeType: "application/pdf",
      buffer: pdfContent,
    });

    await studentPage.getByRole("button", { name: "제출" }).click();
    await expectNotification(studentPage, "success", "제출 완료");

    await studentPage.close();
    await studentCtx.close();
  });
});
