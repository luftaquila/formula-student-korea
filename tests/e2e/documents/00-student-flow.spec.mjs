import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Documents student flow", () => {
  test.use({ storageState: storageStatePath("student") });

  test("shows session list with seeded session", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Verify team info card shows (student is mapped to team 1 = 서울대학교 SNU Racing)
    await expect(page.locator(".card-header h3").first()).toContainText("서울대학교");
    await expect(page.locator(".card-header h3").first()).toContainText("SNU Racing");

    // Verify the seeded session appears in the list
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await expect(sessionCard).toBeVisible();

    // Verify session has submission deadline info
    await expect(sessionCard.locator(".info-label").filter({ hasText: "제출 마감" })).toBeVisible();
  });

  test("clicks session to view details and sees upload form", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Click the session card
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Verify session detail page loaded
    await expect(page.locator("h3").first()).toContainText("E2E 테스트 세션");

    // Verify session info is displayed
    await expect(page.locator(".info-label").filter({ hasText: "제출 마감" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "용량 제한" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "허용 형식" })).toBeVisible();

    // Verify the notice text is shown
    await expect(page.locator(".notice-box")).toContainText("테스트용 제출 세션입니다.");

    // Verify the upload area is visible (session is active)
    await expect(page.locator(".drop-zone")).toBeVisible();
    await expect(page.locator(".drop-content")).toContainText("파일을 드래그하거나 클릭하여 선택");

    // Verify allowed extensions hint is shown
    await expect(page.locator(".drop-hint")).toContainText("PDF");
  });

  test("uploads a file and verifies submission", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to session detail
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Create a test PDF file (minimal valid PDF)
    const pdfContent = Buffer.from(
      "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );

    // Use the hidden file input to upload
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "e2e-test-document.pdf",
      mimeType: "application/pdf",
      buffer: pdfContent,
    });

    // Verify the file appears in selected files list
    await expect(page.locator(".selected-file")).toBeVisible();
    await expect(page.locator(".selected-file .file-name")).toContainText("e2e-test-document.pdf");

    // Submit
    await page.getByRole("button", { name: "제출" }).click();

    // Verify success notification
    await expectNotification(page, "success", "제출 완료");
    await waitForPageReady(page);

    // Verify the submission card appears
    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();
    await expect(page.locator(".badge").filter({ hasText: "제출 완료" })).toBeVisible();

    // Verify file name appears in the existing files list
    await expect(page.locator(".file-item .file-name")).toContainText("e2e-test-document.pdf");
  });

  test("can view previously uploaded submission", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to session detail
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Verify the previous submission is displayed
    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();
    await expect(page.locator(".badge").filter({ hasText: "제출 완료" })).toBeVisible();

    // Verify submission details
    await expect(page.locator(".sub-info .info-label").filter({ hasText: "제출일" })).toBeVisible();
    await expect(page.locator(".sub-info .info-label").filter({ hasText: "용량" })).toBeVisible();

    // Verify file is listed and clickable
    const fileItem = page.locator(".file-item").filter({ hasText: "e2e-test-document.pdf" });
    await expect(fileItem).toBeVisible();
  });

  test("downloads previously uploaded file", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to session detail
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Verify the file item is visible
    const fileItem = page.locator(".file-item").filter({ hasText: "e2e-test-document.pdf" });
    await expect(fileItem).toBeVisible();

    // Get session list to find the session ID (student API returns { team, sessions })
    const sessionsRes = await page.request.get("/documents/api/sessions");
    expect(sessionsRes.status()).toBe(200);
    const sessionsData = await sessionsRes.json();
    const session = sessionsData.sessions.find((s) => s.name === "E2E 테스트 세션");
    expect(session).toBeTruthy();

    // Fetch session detail (student API returns { session, submission, files })
    const detailRes = await page.request.get(`/documents/api/sessions/${session.id}`);
    expect(detailRes.status()).toBe(200);
    const detail = await detailRes.json();
    expect(detail.submission).toBeTruthy();
    expect(detail.files?.length).toBeGreaterThanOrEqual(1);

    const file = detail.files.find((f) => f.original_name === "e2e-test-document.pdf");
    expect(file).toBeTruthy();

    // Download the file via API and verify success
    const downloadRes = await page.request.get(`/documents/api/submissions/${detail.submission.id}/files/${file.id}`);
    expect(downloadRes.status()).toBe(200);
  });

  test("rejects files with disallowed extensions", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to session detail
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Try to upload a .txt file (not in allowed extensions: pdf, docx, xlsx)
    const txtContent = Buffer.from("This is a test text file");
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "invalid-file.txt",
      mimeType: "text/plain",
      buffer: txtContent,
    });

    // Should show error notification about disallowed extension
    await expectNotification(page, "error", "허용되지 않는 파일");

    // The file should not appear in the selected files list
    await expect(page.locator(".selected-file").filter({ hasText: "invalid-file.txt" })).not.toBeVisible();
  });

  test("back button navigates to session list", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to session detail
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Click back button
    await page.locator(".back-btn").click();
    await waitForPageReady(page);

    // Verify we're back on session list
    await expect(page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" })).toBeVisible();
  });
});
