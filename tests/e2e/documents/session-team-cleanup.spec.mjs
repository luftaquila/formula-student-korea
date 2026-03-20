import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Documents session team cleanup", () => {
  test.use({ storageState: storageStatePath("chief") });

  test("removes submissions when team is removed from session", async ({ page, browser }) => {
    // 1. Create a session with teams [1, 2, 3]
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const lateEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");

    const createRes = await page.request.post("/documents/api/admin/sessions", {
      data: {
        name: "E2E 팀 정리 테스트",
        notice: "",
        start_at: fmt(start),
        end_at: fmt(end),
        late_end_at: fmt(lateEnd),
        max_file_size: 10485760,
        allowed_extensions: "pdf",
        year: YEAR,
        teams: [1, 2, 3],
      },
    });
    expect(createRes.status()).toBe(201);
    const { id: sessionId } = await createRes.json();

    // 2. Submit a file as student (team 1)
    const studentContext = await browser.newContext({ storageState: storageStatePath("student") });
    const studentPage = await studentContext.newPage();

    const pdfContent = Buffer.from(
      "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );

    const submitRes = await studentPage.request.post(`/documents/api/sessions/${sessionId}/submit`, {
      multipart: {
        file: {
          name: "cleanup-test.pdf",
          mimeType: "application/pdf",
          buffer: pdfContent,
        },
      },
    });
    expect(submitRes.status()).toBe(200);
    await studentContext.close();

    // 3. Update session: remove team 1 from the team list
    const updateRes = await page.request.put(`/documents/api/admin/sessions/${sessionId}`, {
      data: {
        name: "E2E 팀 정리 테스트",
        notice: "",
        start_at: fmt(start),
        end_at: fmt(end),
        late_end_at: fmt(lateEnd),
        max_file_size: 10485760,
        allowed_extensions: "pdf",
        teams: [2, 3],
      },
    });
    expect(updateRes.status()).toBe(200);

    // 4. Check session status — team 1 should have no submission record
    const statusRes = await page.request.get(`/documents/api/admin/sessions/${sessionId}/status`);
    expect(statusRes.status()).toBe(200);
    const status = await statusRes.json();
    const team1Status = status.status.find((s) => s.team_num === 1);
    expect(team1Status).toBeUndefined();

    // 5. Cleanup: delete the session
    await page.request.delete(`/documents/api/admin/sessions/${sessionId}`);
  });
});
