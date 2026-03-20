import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const pdfContent = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

test.describe("Documents student resubmission flow", () => {
  test.use({ storageState: storageStatePath("student") });

  test("resubmitting replaces the previous submission", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    // Navigate to the seeded session
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 테스트 세션" });
    await sessionCard.click();
    await waitForPageReady(page);

    // Verify there is an existing submission (from 00-student-flow.spec.mjs)
    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();

    // Accept the confirm dialog for resubmission ("기존 제출을 교체합니다")
    page.on("dialog", (dialog) => dialog.accept());

    // Upload a new file to replace the existing submission
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "e2e-resubmit-document.pdf",
      mimeType: "application/pdf",
      buffer: pdfContent,
    });

    // Verify the new file appears in selected files
    await expect(page.locator(".selected-file .file-name")).toContainText("e2e-resubmit-document.pdf");

    // Submit the new file
    await page.getByRole("button", { name: "제출" }).click();

    // Verify success notification
    await expectNotification(page, "success", "제출 완료");
    await waitForPageReady(page);

    // Verify the submission card now shows the new file
    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();
    await expect(page.locator(".badge").filter({ hasText: "제출 완료" })).toBeVisible();
    await expect(page.locator(".file-item .file-name")).toContainText("e2e-resubmit-document.pdf");

    // Restore: re-submit the original file so other tests (admin-download) are not affected
    await fileInput.setInputFiles({
      name: "e2e-test-document.pdf",
      mimeType: "application/pdf",
      buffer: pdfContent,
    });
    await page.getByRole("button", { name: "제출" }).click();
    await expectNotification(page, "success", "제출 완료");
    await waitForPageReady(page);
    await expect(page.locator(".file-item .file-name")).toContainText("e2e-test-document.pdf");
  });
});
