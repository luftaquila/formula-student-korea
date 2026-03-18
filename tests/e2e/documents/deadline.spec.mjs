import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = new Date().getFullYear();

const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");

async function apiCreateSession(data) {
  return fetch(`${BASE_URL}/documents/api/admin/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify(data),
  });
}

async function apiDeleteSession(id) {
  return fetch(`${BASE_URL}/documents/api/admin/sessions/${id}`, {
    method: "DELETE",
    headers: { Cookie: getAuthCookie("chief") },
  });
}

async function apiGetSessions() {
  const res = await fetch(`${BASE_URL}/documents/api/sessions`, {
    headers: { Cookie: getAuthCookie("student") },
  });
  return res.json();
}

test.describe("Documents deadline enforcement", () => {
  const sessionIds = [];

  test.afterAll(async () => {
    // Clean up all test sessions
    for (const id of sessionIds) {
      await apiDeleteSession(id).catch(() => {});
    }
  });

  test("rejects submission to expired session (end_at in the past)", async ({ browser }) => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    // Create a session that has already expired (no late_end_at)
    const createRes = await apiCreateSession({
      name: "E2E 마감 테스트 (만료됨)",
      notice: "이미 마감된 세션",
      start_at: fmt(twoDaysAgo),
      end_at: fmt(oneDayAgo),
      max_file_size: 10485760,
      allowed_extensions: "pdf",
      year: YEAR,
      teams: [1],
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    sessionIds.push(id);

    // Try to submit as student via API
    const formData = new FormData();
    const blob = new Blob(["%PDF-1.0 test content"], { type: "application/pdf" });
    formData.append("files", blob, "test.pdf");

    const submitRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}/submit`, {
      method: "POST",
      headers: { Cookie: getAuthCookie("student") },
      body: formData,
    });

    // Should be rejected
    expect(submitRes.status).toBe(400);
    const text = await submitRes.text();
    expect(text).toContain("제출 기간이 종료되었습니다");
  });

  test("rejects submission before start_at", async () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create a session that hasn't started yet
    const createRes = await apiCreateSession({
      name: "E2E 미시작 테스트",
      notice: "아직 시작 안 된 세션",
      start_at: fmt(tomorrow),
      end_at: fmt(nextWeek),
      max_file_size: 10485760,
      allowed_extensions: "pdf",
      year: YEAR,
      teams: [1],
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    sessionIds.push(id);

    // Try to submit as student via API
    const formData = new FormData();
    const blob = new Blob(["%PDF-1.0 test content"], { type: "application/pdf" });
    formData.append("files", blob, "test.pdf");

    const submitRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}/submit`, {
      method: "POST",
      headers: { Cookie: getAuthCookie("student") },
      body: formData,
    });

    expect(submitRes.status).toBe(400);
    const text = await submitRes.text();
    expect(text).toContain("제출 기간이 아닙니다");
  });

  test("allows late submission when within late_end_at window", async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create session: end_at is past, but late_end_at is in the future
    const createRes = await apiCreateSession({
      name: "E2E 지각제출 테스트",
      notice: "지각 제출 가능한 세션",
      start_at: fmt(twoDaysAgo),
      end_at: fmt(oneDayAgo),
      late_end_at: fmt(nextWeek),
      max_file_size: 10485760,
      allowed_extensions: "pdf",
      year: YEAR,
      teams: [1],
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    sessionIds.push(id);

    // Submit as student via API — should succeed with is_late flag
    const formData = new FormData();
    const blob = new Blob(["%PDF-1.0 test content for late submission"], { type: "application/pdf" });
    formData.append("files", blob, "late-test.pdf");

    const submitRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}/submit`, {
      method: "POST",
      headers: { Cookie: getAuthCookie("student") },
      body: formData,
    });

    expect(submitRes.status).toBe(200);

    // Verify the submission is marked as late
    const sessionRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}`, {
      headers: { Cookie: getAuthCookie("student") },
    });
    const sessionData = await sessionRes.json();
    expect(sessionData.submission).toBeTruthy();
    expect(sessionData.submission.is_late).toBe(1);
  });

  test("rejects submission after late_end_at", async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    // Create session: both end_at and late_end_at are in the past
    const createRes = await apiCreateSession({
      name: "E2E 완전마감 테스트",
      notice: "지각 기한도 지난 세션",
      start_at: fmt(threeDaysAgo),
      end_at: fmt(twoDaysAgo),
      late_end_at: fmt(oneDayAgo),
      max_file_size: 10485760,
      allowed_extensions: "pdf",
      year: YEAR,
      teams: [1],
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    sessionIds.push(id);

    // Try to submit
    const formData = new FormData();
    const blob = new Blob(["%PDF-1.0 test"], { type: "application/pdf" });
    formData.append("files", blob, "test.pdf");

    const submitRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}/submit`, {
      method: "POST",
      headers: { Cookie: getAuthCookie("student") },
      body: formData,
    });

    expect(submitRes.status).toBe(400);
    const text = await submitRes.text();
    expect(text).toContain("제출 기간이 종료되었습니다");
  });

  test("rejects file exceeding size limit", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create session with very small file size limit (512 bytes)
    const createRes = await apiCreateSession({
      name: "E2E 용량제한 테스트",
      notice: "작은 용량 제한 세션",
      start_at: fmt(yesterday),
      end_at: fmt(nextWeek),
      max_file_size: 512,
      allowed_extensions: "pdf",
      year: YEAR,
      teams: [1],
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json();
    sessionIds.push(id);

    // Create a file larger than 512 bytes
    const largeContent = "x".repeat(1024);
    const formData = new FormData();
    const blob = new Blob([largeContent], { type: "application/pdf" });
    formData.append("files", blob, "large-file.pdf");

    const submitRes = await fetch(`${BASE_URL}/documents/api/sessions/${id}/submit`, {
      method: "POST",
      headers: { Cookie: getAuthCookie("student") },
      body: formData,
    });

    // Should be rejected with 413
    expect(submitRes.status).toBe(413);
    const text = await submitRes.text();
    expect(text).toContain("파일 용량 제한");
  });

  test("student UI shows late submission badge", async ({ browser }) => {
    // Find the late submission session we created earlier
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    await page.goto("/documents");
    await waitForPageReady(page);

    // Click on the late submission session
    const sessionCard = page.locator(".session-card").filter({ hasText: "E2E 지각제출 테스트" });
    await expect(sessionCard).toBeVisible();
    await sessionCard.click();
    await waitForPageReady(page);

    // Verify the "지각 제출" badge is shown
    await expect(page.locator(".badge").filter({ hasText: "지각 제출" })).toBeVisible();

    await context.close();
  });
});
