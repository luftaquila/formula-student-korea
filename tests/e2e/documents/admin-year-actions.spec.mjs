import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import {
  PDF_CONTENT,
  createDocumentSession,
  deleteDocumentSession,
  submitDocument,
} from "../helpers/documents.mjs";

const YEAR = new Date().getFullYear();
const SESSION_NAME = "E2E 연도별 다운로드 격리 세션";

test.describe("Documents admin year-level actions", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;

  test.beforeAll(async ({ browser }) => {
    const chief = await browser.newContext({ storageState: storageStatePath("chief") });
    const student = await browser.newContext({ storageState: storageStatePath("student") });
    try {
      sessionId = await createDocumentSession(chief.request, SESSION_NAME, {
        year: YEAR,
        teams: [1],
        allowedExtensions: "pdf",
      });
      await submitDocument(student.request, sessionId, "year-archive.pdf", { buffer: PDF_CONTENT });
    } finally {
      await chief.close();
      await student.close();
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

  test("downloads current-year files as a zip from the dashboard", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "전체 다운로드" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`FSK_${YEAR}_documents.zip`);
    expect(await download.failure()).toBeNull();

    const stream = await download.createReadStream();
    const firstChunk = await new Promise((resolve, reject) => {
      stream.once("data", resolve);
      stream.once("error", reject);
    });
    expect(firstChunk.subarray(0, 2).toString("latin1")).toBe("PK");
    stream.destroy();
  });

  test("purge button shows confirm dialog with correct message", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const dialogPromise = page.waitForEvent("dialog");
    const clickPromise = page.getByRole("button", { name: "파일 정리" }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain("파일을 삭제합니다");
    expect(dialog.message()).toContain("제출 기록은 유지됩니다");
    await dialog.dismiss();
    await clickPromise;
  });
});
