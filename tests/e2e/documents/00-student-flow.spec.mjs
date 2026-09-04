import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, expectNotificationAfter } from "../helpers/utils.mjs";
import { PDF_CONTENT } from "../helpers/documents.mjs";

const SESSION_NAME = "E2E 테스트 세션";

test.describe("Documents student flow", () => {
  test.use({ storageState: storageStatePath("student") });

  test("lists the assigned team's session, opens its details, and navigates back", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    await expect(page.locator(".card-header h3").first()).toContainText("서울대학교");
    await expect(page.locator(".card-header h3").first()).toContainText("SNU Racing");

    const sessionCard = page.locator(".session-card").filter({ hasText: SESSION_NAME });
    await expect(sessionCard).toBeVisible();
    await expect(sessionCard.locator(".info-label").filter({ hasText: "제출 마감" })).toBeVisible();
    await sessionCard.click();

    await expect(page.locator("h3").first()).toContainText(SESSION_NAME);
    await expect(page.locator(".info-label").filter({ hasText: "제출 마감" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "용량 제한" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "허용 형식" })).toBeVisible();
    await expect(page.locator(".notice-box")).toContainText("테스트용 제출 세션입니다.");
    await expect(page.locator(".drop-zone")).toBeVisible();
    await expect(page.locator(".drop-hint")).toContainText("PDF");

    await page.locator(".back-btn").click();
    await expect(sessionCard).toBeVisible();
  });

  test("uploads, views, downloads, and validates files in one student journey", async ({ page }) => {
    await page.goto("/documents");
    await page.locator(".session-card").filter({ hasText: SESSION_NAME }).click();
    await waitForPageReady(page);

    // A retry may encounter the successful submission from the first attempt.
    page.on("dialog", (dialog) => dialog.accept());
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "e2e-test-document.pdf",
      mimeType: "application/pdf",
      buffer: PDF_CONTENT,
    });
    await expect(page.locator(".selected-file .file-name")).toContainText("e2e-test-document.pdf");
    await page.getByRole("button", { name: "제출" }).click();
    await expectNotification(page, "success", "제출 완료");

    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();
    await expect(page.locator(".badge").filter({ hasText: "제출 완료" })).toBeVisible();
    await expect(page.locator(".file-item .file-name")).toContainText("e2e-test-document.pdf");
    await expect(page.locator(".sub-info .info-label").filter({ hasText: "제출일" })).toBeVisible();

    const sessionsRes = await page.request.get("/competition/api/v1/documents/sessions");
    expect(sessionsRes.status()).toBe(200);
    const session = (await sessionsRes.json()).sessions.find((item) => item.name === SESSION_NAME);
    expect(session?.id).toBeTruthy();
    const detailRes = await page.request.get(`/competition/api/v1/documents/sessions/${session.id}`);
    expect(detailRes.status()).toBe(200);
    const detail = await detailRes.json();
    expect(detail.submission?.id).toBeTruthy();
    expect(detail.files).toHaveLength(1);
    const downloadRes = await page.request.get(
      `/competition/api/v1/documents/submissions/${detail.submission.id}/files/${detail.files[0].id}`,
    );
    expect(downloadRes.status()).toBe(200);
    expect((await downloadRes.body()).length).toBeGreaterThan(0);

    await expectNotificationAfter(page, "error", "허용되지 않는 파일", () => fileInput.setInputFiles({
      name: "invalid-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("invalid extension"),
    }));
    await expect(page.locator(".selected-file").filter({ hasText: "invalid-file.txt" })).not.toBeVisible();
  });
});
