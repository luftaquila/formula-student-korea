import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import {
  PDF_CONTENT,
  createDocumentSession,
  deleteDocumentSession,
  submitDocument,
} from "../helpers/documents.mjs";

const YEAR = currentCompetitionYear();
const NEXT_YEAR = YEAR + 1;
const SESSION_NAME = "E2E 연도별 다운로드 격리 세션";

async function exposeNextYear(page) {
  await page.route("**/competition/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    await route.fulfill({
      response,
      json: {
        ...meta,
        years: [...new Set([...meta.years, NEXT_YEAR])].sort((a, b) => b - a),
      },
    });
  });
}

async function expectDescendingYearsWithCurrentSelected(yearSelect) {
  await expect(yearSelect).toHaveValue(String(YEAR));
  const yearOptions = await yearSelect.locator("option").evaluateAll((options) =>
    options.map((option) => Number(option.value)),
  );
  expect(yearOptions[0]).toBe(NEXT_YEAR);
  expect(yearOptions).toEqual([...yearOptions].sort((a, b) => b - a));
}

test.describe("Documents admin year-level actions", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("operationsManager") });

  let sessionId;

  test.beforeAll(async ({ browser }) => {
    const manager = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    const student = await browser.newContext({ storageState: storageStatePath("student") });
    try {
      sessionId = await createDocumentSession(manager.request, SESSION_NAME, {
        year: YEAR,
        teams: [1],
        allowedExtensions: "pdf",
      });
      await submitDocument(student.request, sessionId, "year-archive.pdf", { buffer: PDF_CONTENT });
    } finally {
      await manager.close();
      await student.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const manager = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    try {
      await deleteDocumentSession(manager.request, sessionId);
    } finally {
      await manager.close();
    }
  });

  test("lists years descending without changing the Documents default year", async ({ page }) => {
    await exposeNextYear(page);
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const dashboardYear = page.locator(".filter-bar select.filter-input").first();
    await expectDescendingYearsWithCurrentSelected(dashboardYear);

    await page.getByRole("link", { name: "세션 생성" }).click();
    const sessionYear = page.locator(".session-form select.form-select");
    await expect(sessionYear).toBeVisible();
    await expectDescendingYearsWithCurrentSelected(sessionYear);
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
