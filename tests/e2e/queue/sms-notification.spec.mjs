import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "tilting";

async function apiRegister(num, type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiEnterBooth(num, boothNum = 1, type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(boothNum = 1, type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiGetQueue(type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  return res.json();
}

async function cleanupQueue() {
  await apiExitBooth(1).catch(() => {});
  const queue = await apiGetQueue();
  for (const item of queue) {
    await apiEnterBooth(item.num, 1).catch(() => {});
    await apiExitBooth(1).catch(() => {});
  }
}

test.describe("SMS notification behavior without credentials", () => {
  let originalPenalty;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });
    await cleanupQueue();
  });

  test.afterEach(async () => {
    await cleanupQueue();
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
    // Ensure SMS is disabled
    await fetch(`${BASE_URL}/queue/api/admin/settings/sms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: false }),
    });
  });

  test("SMS enable fails without Naver Cloud env vars", async () => {
    // Attempt to enable SMS — should fail with 400
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/sms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("환경 변수");
  });

  test("SMS rank validation accepts range 1-10", async () => {
    // Valid rank
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/sms-rank`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 5 }),
    });
    expect(res.status).toBe(200);

    // Restore to a default value
    await fetch(`${BASE_URL}/queue/api/admin/settings/sms-rank`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 3 }),
    });
  });

  test("queue operations work without 500 errors when SMS disabled", async () => {
    // Ensure SMS is off
    await fetch(`${BASE_URL}/queue/api/admin/settings/sms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: false }),
    });

    // Register team
    const regRes = await apiRegister(32);
    expect(regRes.status).toBe(201);

    // Enter booth
    const enterRes = await apiEnterBooth(32);
    expect(enterRes.status).toBe(200);

    // Exit booth
    const exitRes = await apiExitBooth();
    expect(exitRes.status).toBe(200);
  });
});
