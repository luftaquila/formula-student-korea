import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const pdfContent = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

test.describe("Documents admin previous submission display", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;

  test("ensure two submissions exist via student API", async ({ browser }) => {
    // Create a student-authenticated browser context to submit files
    const studentCtx = await browser.newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();

    // Get the session ID for the seeded E2E test session
    const sessionsRes = await studentPage.request.get("/documents/api/sessions");
    expect(sessionsRes.ok()).toBeTruthy();
    const sessionsData = await sessionsRes.json();
    const session = sessionsData.sessions.find((s) => s.name === "E2E 테스트 세션");
    expect(session).toBeTruthy();
    sessionId = session.id;

    // Submit first file (may already exist from 00-student-flow, but ensures at least 1)
    const res1 = await studentPage.request.post(`/documents/api/sessions/${sessionId}/submit`, {
      multipart: { files: { name: "prev-test-1.pdf", mimeType: "application/pdf", buffer: pdfContent } },
    });
    expect(res1.ok()).toBeTruthy();

    // Submit second file to create a previous submission
    const res2 = await studentPage.request.post(`/documents/api/sessions/${sessionId}/submit`, {
      multipart: { files: { name: "prev-test-2.pdf", mimeType: "application/pdf", buffer: pdfContent } },
    });
    expect(res2.ok()).toBeTruthy();

    await studentPage.close();
    await studentCtx.close();
  });

  test("shows expand toggle for team with previous submission", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Team 1 (서울대학교) now has 2 submissions, so expand toggle should be visible
    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    const expandBtn = team1Row.locator(".btn-expand");
    await expect(expandBtn).toBeVisible();
  });

  test("clicking expand toggle shows previous submission details", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    await team1Row.locator(".btn-expand").click();

    // Verify the previous submission row appears
    const prevRow = table.locator("tr.row-prev");
    await expect(prevRow).toBeVisible();
    await expect(prevRow.locator(".prev-label")).toContainText("이전 제출");
    await expect(prevRow.locator(".file-link").first()).toBeVisible();
  });

  test("clicking expand toggle again hides previous submission", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    const table = page.locator(".detail-table");
    const team1Row = table.locator("tbody tr").filter({ hasText: "서울대학교" }).first();
    const expandBtn = team1Row.locator(".btn-expand");

    await expandBtn.click();
    await expect(table.locator("tr.row-prev")).toBeVisible();

    await expandBtn.click();
    await expect(table.locator("tr.row-prev")).not.toBeVisible();
  });

  test("team without previous submission has no expand toggle", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const sessionLink = page.locator(".session-link").filter({ hasText: "E2E 테스트 세션" });
    await sessionLink.click();
    await waitForPageReady(page);

    // Team 2 (한양대학교) has no submission at all
    const table = page.locator(".detail-table");
    const team2Row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(team2Row.locator(".btn-expand")).not.toBeVisible();
  });
});
