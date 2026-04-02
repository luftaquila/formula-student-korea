import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const PURGE_YEAR = 2020; // isolated year for destructive purge test

const pdfContent = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

test.describe("Documents admin year-level actions", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  test("download and purge buttons are visible on dashboard", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("button", { name: "전체 다운로드" })).toBeVisible();
    await expect(page.getByRole("button", { name: "파일 정리" })).toBeVisible();
  });

  test("archive endpoint returns zip for current year", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    const res = await page.request.get(`/documents/api/admin/years/${YEAR}/archive`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");
  });

  test("archive returns 404 for year with no sessions", async ({ page }) => {
    const res = await page.request.get("/documents/api/admin/years/2001/archive");
    expect(res.status()).toBe(404);
  });

  test("purge returns 404 for year with no sessions", async ({ page }) => {
    const res = await page.request.delete("/documents/api/admin/years/2001/files");
    expect(res.status()).toBe(404);
  });

  test("purge on isolated year: setup, purge, and verify", async ({ page }) => {
    // Create an isolated session + submission in PURGE_YEAR so we don't affect other tests
    // 1. Create student-team mapping for the purge year
    await page.request.post("/documents/api/admin/student-teams", {
      data: { email: "e2e-student@test.com", team_num: 1, year: PURGE_YEAR },
    });

    // 2. Create a session in the purge year
    const sessionRes = await page.request.post("/documents/api/admin/sessions", {
      data: {
        name: "Purge Test Session",
        start_at: "2020-01-01 00:00",
        end_at: "2030-12-31 23:59",
        late_end_at: "",
        max_file_size: 52428800,
        year: PURGE_YEAR,
        teams: [1],
        allowed_extensions: "pdf",
      },
    });
    expect(sessionRes.ok()).toBeTruthy();
    const { id: purgeSessionId } = await sessionRes.json();

    // 3. Submit a file as student
    const studentCtx = await page.context().browser().newContext({
      storageState: storageStatePath("student"),
    });
    const studentPage = await studentCtx.newPage();
    const submitRes = await studentPage.request.post(`/documents/api/sessions/${purgeSessionId}/submit`, {
      multipart: { files: { name: "purge-test.pdf", mimeType: "application/pdf", buffer: pdfContent } },
    });
    expect(submitRes.ok()).toBeTruthy();
    await studentPage.close();
    await studentCtx.close();

    // 4. Verify file exists via admin status
    const statusBefore = await page.request.get(`/documents/api/admin/sessions/${purgeSessionId}/status`);
    const beforeData = await statusBefore.json();
    expect(beforeData.status[0].files.length).toBeGreaterThan(0);

    // 5. Purge the isolated year
    const purgeRes = await page.request.delete(`/documents/api/admin/years/${PURGE_YEAR}/files`);
    expect(purgeRes.ok()).toBeTruthy();
    const purgeData = await purgeRes.json();
    expect(purgeData.sessions).toBeGreaterThan(0);
    expect(purgeData.files).toBeGreaterThan(0);

    // 6. Verify files are gone but submission record remains
    const statusAfter = await page.request.get(`/documents/api/admin/sessions/${purgeSessionId}/status`);
    const afterData = await statusAfter.json();
    expect(afterData.status[0].submission).toBeTruthy();
    expect(afterData.status[0].files.length).toBe(0);

    // 7. Archive should return 404 (no files left)
    const archiveRes = await page.request.get(`/documents/api/admin/years/${PURGE_YEAR}/archive`);
    expect(archiveRes.status()).toBe(404);

    // Cleanup: delete the test session
    await page.request.delete(`/documents/api/admin/sessions/${purgeSessionId}`);
  });

  test("purge button shows confirm dialog with correct message", async ({ page }) => {
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    // Dismiss the dialog to avoid actually purging
    page.on("dialog", (dialog) => {
      expect(dialog.message()).toContain("파일을 삭제합니다");
      expect(dialog.message()).toContain("제출 기록은 유지됩니다");
      dialog.dismiss();
    });

    await page.getByRole("button", { name: "파일 정리" }).click();
  });
});
