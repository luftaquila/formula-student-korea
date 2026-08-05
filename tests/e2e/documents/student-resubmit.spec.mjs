import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { PDF_CONTENT, createDocumentSession, deleteDocumentSession, submitDocument } from "../helpers/documents.mjs";

const SESSION_NAME = "E2E 재제출 격리 세션";

test.describe("Documents student resubmission flow", () => {
  test.use({ storageState: storageStatePath("student") });

  let sessionId;

  test.beforeAll(async ({ browser }) => {
    const chief = await browser.newContext({ storageState: storageStatePath("chief") });
    const student = await browser.newContext({ storageState: storageStatePath("student") });
    try {
      sessionId = await createDocumentSession(chief.request, SESSION_NAME);
      await submitDocument(student.request, sessionId, "resubmit-original.pdf");
    } finally {
      await student.close();
      await chief.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const chief = await browser.newContext({ storageState: storageStatePath("chief") });
    try {
      await deleteDocumentSession(chief.request, sessionId);
    } finally {
      await chief.close();
    }
  });

  test("resubmitting replaces the previous submission", async ({ page }) => {
    await page.goto("/documents");
    await waitForPageReady(page);

    const sessionCard = page.locator(".session-card").filter({ hasText: SESSION_NAME });
    await sessionCard.click();
    await waitForPageReady(page);

    // The spec owns an existing submission created in beforeAll.
    await expect(page.locator("h3").filter({ hasText: "현재 제출" })).toBeVisible();

    // Accept the confirm dialog for resubmission
    page.on("dialog", (dialog) => dialog.accept());

    // Upload a new file to replace the existing submission
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "e2e-resubmit-document.pdf",
      mimeType: "application/pdf",
      buffer: PDF_CONTENT,
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
  });
});
