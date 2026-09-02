import { test, expect } from "@playwright/test";
import { expectCompactTeamIdentity, storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { createDocumentSession, deleteDocumentSession, submitDocument } from "../helpers/documents.mjs";

const SESSION_NAME = "E2E 관리자 다운로드 격리 세션";
const CP949_FILENAME = "한글-CP949.txt";
const CP949_CONTENT = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);

test.describe("Documents admin submission and download", () => {
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;

  test.beforeAll(async ({ browser }) => {
    const chief = await browser.newContext({ storageState: storageStatePath("chief") });
    const student = await browser.newContext({ storageState: storageStatePath("student") });
    try {
      sessionId = await createDocumentSession(chief.request, SESSION_NAME, {
        allowedExtensions: "txt",
        teams: [1, 2, 3],
      });
      await submitDocument(student.request, sessionId, CP949_FILENAME, {
        mimeType: "text/plain",
        buffer: CP949_CONTENT,
      });
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

  test("shows exact submission status and previews CP949 Korean text", async ({ page }) => {
    await page.goto("/documents/admin");
    const sessionLink = page.locator(".main-table:not([data-table-head-copy]) .session-link").filter({ hasText: SESSION_NAME });
    await expect(sessionLink).toBeVisible();
    await sessionLink.click();
    await waitForPageReady(page);

    await expect(page.locator("h3").first()).toContainText(SESSION_NAME);
    const table = page.locator(".detail-table:not([data-table-head-copy])");
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(3);
    for (const heading of ["엔트리", "상태", "파일"]) {
      await expect(table.locator("th").filter({ hasText: heading })).toBeVisible();
    }
    await expect(table.getByRole("columnheader", { name: "제출 일시" })).toBeVisible();

    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(team1Row.locator(".badge-success")).toContainText("제출");
    const fileLink = team1Row.locator(".file-link");
    await expect(fileLink).toContainText(CP949_FILENAME);

    const team2Row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(team2Row.locator(".col-status .badge-default")).toContainText("미제출");
    const chips = page.locator(".count-chips");
    await expect(chips.locator(".badge-success")).toContainText("제출 1");
    await expect(chips.locator(".badge-default")).toContainText("미제출 2");
    await expect(chips.locator(".badge-primary")).toContainText("전체 3");

    for (const label of ["시작", "제출 마감", "용량 제한", "허용 확장자"]) {
      await expect(page.locator(".info-label").filter({ hasText: label })).toBeVisible();
    }
    await expect(page.locator(".session-notice")).toContainText("격리된 E2E 제출 세션");

    const responsePromise = page.context().waitForEvent("response", {
      predicate: (response) => response.url().includes("/competition/api/v1/documents/admin/submissions/")
        && response.url().includes("/files/"),
    });
    const previewPromise = page.waitForEvent("popup");
    await fileLink.click();
    const [response, preview] = await Promise.all([responsePromise, previewPromise]);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/plain; charset=euc-kr");
    const disposition = decodeURIComponent(response.headers()["content-disposition"]);
    expect(disposition).toContain("inline");
    expect(disposition).toContain(CP949_FILENAME);
    await expect(preview.locator("body")).toHaveText("한글");
    await preview.close();
    await page.locator(".back-btn").click();
    await expect(page.locator("h3").filter({ hasText: "팀 목록" })).toBeVisible();
  });

  test("session detail uses the compact mobile identity and persistent type filter", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await page.goto(`/documents/admin/session/${sessionId}`);
    await waitForPageReady(page);

    const table = page.locator(".detail-table:not([data-table-head-copy])");
    const row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(page.getByTestId("documents-session-sticky-header").locator("th").first()).toContainText("엔트리");
    await expect(page.locator(".sticky-freeze-line")).toHaveCount(0);
    await expect(row.locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(row.locator(".team-mobile-entry-name")).toBeVisible();
    await expect(row.locator(".team-mobile-entry-type")).toBeVisible();
    await expect(row.locator("td.col-team")).toBeHidden();
    await expect(row.locator("td.col-type")).toBeHidden();
    await expectCompactTeamIdentity(table);

    const cv = page.getByTestId("documents-session-type-filter").locator("label", { hasText: "CV" }).locator("input");
    await cv.uncheck();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("documents-session-type-filter"))).toContain('"CV":false');
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("documents-session-type-filter").locator("label", { hasText: "CV" }).locator("input")).not.toBeChecked();
  });

  test("keeps the final document columns aligned in the pinned header", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 600 });
    await page.goto(`/documents/admin/session/${sessionId}`);
    await waitForPageReady(page);

    const scroller = page.getByTestId("documents-session-table-scroll");
    await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    const alignment = await page.evaluate(() => {
      const scrollerElement = document.querySelector('[data-testid="documents-session-table-scroll"]');
      const band = document.querySelector('[data-testid="documents-session-sticky-header"]');
      const realHeaders = [...scrollerElement.querySelectorAll("thead th")];
      const pinnedHeaders = [...band.querySelectorAll("thead th")];
      const lastTwo = realHeaders.slice(-2).map((cell, index) => {
        const real = cell.getBoundingClientRect();
        const pinned = pinnedHeaders[pinnedHeaders.length - 2 + index].getBoundingClientRect();
        return { drift: Math.abs(real.left - pinned.left), width: pinned.width, right: pinned.right };
      });
      return { bandRight: band.getBoundingClientRect().right, lastTwo };
    });
    for (const header of alignment.lastTwo) {
      expect(header.drift).toBeLessThanOrEqual(1);
      expect(header.width).toBeGreaterThan(1);
    }
    expect(alignment.lastTwo.at(-1).right).toBeLessThanOrEqual(alignment.bandRight + 1);

    const submittedAt = page.locator(".detail-table tbody tr", { hasText: "서울대학교" }).locator(".date-time-lines");
    await expect(submittedAt.locator("span")).toHaveCount(2);
  });
});
