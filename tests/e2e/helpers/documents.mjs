const YEAR = new Date().getFullYear();

export const PDF_CONTENT = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

async function requireStatus(response, expected, label) {
  if (response.status() !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status()}: ${await response.text()}`);
  }
  return response;
}

export async function createDocumentSession(request, name, options = {}) {
  const now = Date.now();
  const start = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const end = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const lateEnd = new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const response = await request.post("/documents/api/admin/sessions", {
    data: {
      name,
      notice: options.notice ?? "격리된 E2E 제출 세션",
      start_at: options.startAt ?? start,
      end_at: options.endAt ?? end,
      late_end_at: options.lateEndAt ?? lateEnd,
      max_file_size: options.maxFileSize ?? 10485760,
      allowed_extensions: options.allowedExtensions ?? "pdf,docx,xlsx",
      year: options.year ?? YEAR,
      teams: options.teams ?? [1],
    },
  });
  await requireStatus(response, 201, `create document session ${name}`);
  return (await response.json()).id;
}

export async function deleteDocumentSession(request, sessionId) {
  if (!sessionId) return;
  const response = await request.delete(`/documents/api/admin/sessions/${sessionId}`);
  if (![200, 404].includes(response.status())) {
    throw new Error(`delete document session ${sessionId}: ${response.status()} ${await response.text()}`);
  }
}

export async function submitDocument(request, sessionId, name, options = {}) {
  const response = await request.post(`/documents/api/sessions/${sessionId}/submit`, {
    multipart: {
      files: {
        name,
        mimeType: options.mimeType ?? "application/pdf",
        buffer: options.buffer ?? PDF_CONTENT,
      },
    },
  });
  await requireStatus(response, 200, `submit to document session ${sessionId}`);
  return response.json();
}
