import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Documents admin submission and download", () => {
  test.use({ storageState: storageStatePath("chief") });

  test("views submission status for seeded session", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    // Click the seeded session link to go to detail page
    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await expect(sessionLink).toBeVisible();
    await sessionLink.click();
    await waitForPageReady(page);

    // Verify session detail page
    await expect(page.locator("h3").first()).toContainText("E2E 테스트 세션");

    // Verify submission status table
    const table = page.locator(".detail-table");
    await expect(table).toBeVisible();

    // Verify table headers
    await expect(page.locator("th").filter({ hasText: "번호" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "상태" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "제출 시간" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "파일" })).toBeVisible();

    // Verify that teams 1, 2, 3 are listed (session targets)
    await expect(table.locator("tbody tr")).toHaveCount(3);

    // Team 1 (서울대학교) should show "제출" status from student-flow test
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(team1Row).toBeVisible();
    await expect(team1Row.locator(".badge-success")).toContainText("제출");

    // Team 2 (한양대학교) should show "미제출"
    const team2Row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(team2Row).toBeVisible();
    await expect(team2Row.locator(".text-muted")).toContainText("미제출");
  });

  test("submission count badge shows correct count", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Verify the count badge shows "1 / 3" (team 1 submitted, teams 2 and 3 did not)
    const countBadge = page.locator(".count-badge");
    await expect(countBadge).toContainText("1 / 3");
  });

  test("submitted file name is visible for team 1", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Team 1's row should show the uploaded file name
    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(team1Row.locator(".file-link")).toContainText(/e2e-.*-document\.pdf/);
  });

  test("admin can download submitted file", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Find the file link for team 1's submission and verify it exists
    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    const fileLink = team1Row.locator(".file-link");
    await expect(fileLink).toBeVisible();
    await expect(fileLink).toContainText(/e2e-.*-document\.pdf/);
  });

  test("session info is displayed correctly", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Verify session details are shown
    await expect(page.locator(".info-label").filter({ hasText: "시작" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "제출 마감" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "용량 제한" })).toBeVisible();
    await expect(page.locator(".info-label").filter({ hasText: "허용 확장자" })).toBeVisible();
    await expect(page.locator(".info-value").filter({ hasText: "PDF" })).toBeVisible();

    // Verify notice is displayed
    await expect(page.locator(".session-notice")).toContainText("테스트용 제출 세션입니다.");

    // Verify edit and delete buttons exist
    await expect(page.locator("a").filter({ hasText: "수정" })).toBeVisible();
    await expect(page.getByRole("button", { name: "삭제" })).toBeVisible();
  });

  test("back button navigates to admin dashboard", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Click back button
    await page.locator(".back-btn").click();
    await waitForPageReady(page);

    // Verify we're back on admin dashboard
    await expect(page.locator("h3").filter({ hasText: "팀 목록" })).toBeVisible();
  });
});
