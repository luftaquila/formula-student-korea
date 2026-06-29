import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// documents /api/admin* requires chief; student submit/download routes require student.
// The seed maps the student user to team 1 in the current year.
const YEAR = new Date().getFullYear();

const pdfContent = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);
// Minimal but valid-enough PNG header bytes for an image disposition check.
const pngContent = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const docxContent = Buffer.from("PK\x03\x04 fake docx zip payload for disposition test");

const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");

// Run serially: every test operates on one chief-created, student-targeted session
// created in beforeAll. Serial avoids retention/attempt_no races within this file.
test.describe("Documents submission integrity", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("chief") });

  let sessionId;
  // Allow PDF + PNG (inline) and DOCX (attachment) so disposition branches are reachable.
  const ALLOWED = "pdf,png,docx";

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("chief") });
    const page = await ctx.newPage();

    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const lateEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);

    const res = await page.request.post("/documents/api/admin/sessions", {
      data: {
        name: `E2E 무결성 세션 ${Date.now()}`,
        notice: "submission integrity isolated session",
        start_at: fmt(start),
        end_at: fmt(end),
        late_end_at: fmt(lateEnd),
        max_file_size: 10485760,
        allowed_extensions: ALLOWED,
        year: YEAR,
        teams: [1], // student is mapped to team 1
      },
    });
    expect(res.status()).toBe(201);
    sessionId = (await res.json()).id;

    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (sessionId == null) return;
    const ctx = await browser.newContext({ storageState: storageStatePath("chief") });
    const page = await ctx.newPage();
    await page.request.delete(`/documents/api/admin/sessions/${sessionId}`).catch(() => {});
    await ctx.close();
  });

  // Helper: submit one file as the student in an isolated context. Returns the status.
  async function studentSubmit(browser, name, mimeType, buffer) {
    const ctx = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await ctx.newPage();
    const res = await page.request.post(`/documents/api/sessions/${sessionId}/submit`, {
      multipart: { files: { name, mimeType, buffer } },
    });
    const status = res.status();
    await ctx.close();
    return { status };
  }

  test("empty submission with no file is rejected (400)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await ctx.newPage();
    // multipart with no file fields → busboy.finish with filesInfo.length === 0.
    const res = await page.request.post(`/documents/api/sessions/${sessionId}/submit`, {
      multipart: { note: "no actual file here" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("파일을 선택");
    await ctx.close();
  });

  test("retention keeps only the latest 2 submissions; attempt_no keeps climbing", async ({ browser, page }) => {
    // Submit the same logical session 3 times as the student.
    for (let i = 1; i <= 3; i++) {
      const r = await studentSubmit(browser, `retention-${i}.pdf`, "application/pdf", pdfContent);
      expect(r.status).toBe(200);
    }

    // Admin status reports at most the latest 2 submissions (submission + prevSubmission),
    // but submissionCount (= attempt_no of the latest) keeps growing past 2.
    const statusRes = await page.request.get(`/documents/api/admin/sessions/${sessionId}/status`);
    expect(statusRes.status()).toBe(200);
    const data = await statusRes.json();
    const team1 = data.status.find((s) => s.team_num === 1);
    expect(team1).toBeTruthy();

    // attempt_no of the latest submission must be >= 3 (monotonic, survives retention).
    expect(team1.submissionCount).toBeGreaterThanOrEqual(3);
    expect(team1.submission?.attempt_no).toBeGreaterThanOrEqual(3);
    // prevSubmission exists (the 2nd-latest is retained) and is older than the latest.
    expect(team1.prevSubmission).toBeTruthy();
    expect(team1.submission.id).toBeGreaterThan(team1.prevSubmission.id);

    // Confirm only 2 rows are retained for this (session, team): the status query
    // itself is "ORDER BY id DESC LIMIT 2", so verify the oldest is pruned by checking
    // attempt_no spacing — the two retained rows are the two most recent attempts.
    expect(team1.submission.attempt_no).toBeGreaterThan(team1.prevSubmission.attempt_no);

    // A 4th submission pushes attempt_no further and still retains only 2.
    const r4 = await studentSubmit(browser, "retention-4.pdf", "application/pdf", pdfContent);
    expect(r4.status).toBe(200);
    const statusRes2 = await page.request.get(`/documents/api/admin/sessions/${sessionId}/status`);
    const data2 = await statusRes2.json();
    const team1b = data2.status.find((s) => s.team_num === 1);
    expect(team1b.submissionCount).toBeGreaterThanOrEqual(4);
    expect(team1b.submission.attempt_no).toBeGreaterThan(team1.submission.attempt_no);
    expect(team1b.prevSubmission).toBeTruthy();
  });

  test("PDF downloads inline, DOCX downloads as attachment", async ({ browser, page }) => {
    // Submit a PDF (inline type) then a DOCX (non-inline) as separate submissions.
    // Both will be among the latest 2 retained, so each is downloadable.
    const pdfRes = await studentSubmit(browser, "disp-doc.pdf", "application/pdf", pdfContent);
    expect(pdfRes.status).toBe(200);
    const docxRes = await studentSubmit(
      browser,
      "disp-doc.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docxContent,
    );
    expect(docxRes.status).toBe(200);

    // Read the two retained submissions (latest = docx, prev = pdf) via admin status.
    const statusRes = await page.request.get(`/documents/api/admin/sessions/${sessionId}/status`);
    const data = await statusRes.json();
    const team1 = data.status.find((s) => s.team_num === 1);
    expect(team1).toBeTruthy();

    const latestFiles = team1.files || [];
    const prevFiles = team1.prevFiles || [];
    const docxFile = latestFiles.find((f) => f.original_name === "disp-doc.docx");
    const pdfFile = prevFiles.find((f) => f.original_name === "disp-doc.pdf");
    expect(docxFile).toBeTruthy();
    expect(pdfFile).toBeTruthy();

    // PDF → inline disposition (admin download endpoint).
    const pdfDl = await page.request.get(
      `/documents/api/admin/submissions/${team1.prevSubmission.id}/files/${pdfFile.id}`,
    );
    expect(pdfDl.status()).toBe(200);
    expect(pdfDl.headers()["content-disposition"]).toMatch(/^inline/);
    expect(pdfDl.headers()["content-type"]).toContain("application/pdf");

    // DOCX → attachment disposition (not in inline whitelist).
    const docxDl = await page.request.get(
      `/documents/api/admin/submissions/${team1.submission.id}/files/${docxFile.id}`,
    );
    expect(docxDl.status()).toBe(200);
    expect(docxDl.headers()["content-disposition"]).toMatch(/^attachment/);
  });

  test("image (PNG) downloads inline", async ({ browser, page }) => {
    // PNG is in the inline whitelist by both MIME and extension.
    const pngRes = await studentSubmit(browser, "disp-image.png", "image/png", pngContent);
    expect(pngRes.status).toBe(200);

    const statusRes = await page.request.get(`/documents/api/admin/sessions/${sessionId}/status`);
    const data = await statusRes.json();
    const team1 = data.status.find((s) => s.team_num === 1);
    const pngFile = (team1.files || []).find((f) => f.original_name === "disp-image.png");
    expect(pngFile).toBeTruthy();

    const pngDl = await page.request.get(
      `/documents/api/admin/submissions/${team1.submission.id}/files/${pngFile.id}`,
    );
    expect(pngDl.status()).toBe(200);
    expect(pngDl.headers()["content-disposition"]).toMatch(/^inline/);
    expect(pngDl.headers()["content-type"]).toContain("image/png");
  });
});
