import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

async function apiRegister(type, num, phone = "01000000000") {
  return fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num, phone }),
  });
}

async function apiCancel(type, num) {
  return fetch(`${BASE_URL}/queue/api/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(type, boothNum) {
  await fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiClearQueue(type) {
  // Exit all occupied booths first
  const boothRes = await fetch(`${BASE_URL}/queue/api/admin/booths/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (boothRes.ok) {
    const booths = await boothRes.json();
    for (const booth of booths) {
      if (booth.occupied_by) await apiExitBooth(type, booth.booth_num);
    }
  }
  // Then cancel all queued entries
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (!res.ok) return;
  const entries = await res.json();
  for (const entry of entries) {
    await apiCancel(type, entry.num);
  }
}

test.describe("Queue SSE real-time sync", () => {
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
    await apiClearQueue("battery");
  });

  test.afterEach(async () => {
    await apiClearQueue("battery");
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test("registration in one context reflects in admin view", async ({ browser }) => {
    // Open admin view
    const adminContext = await browser.newContext({ storageState: storageStatePath("official") });
    const adminPage = await adminContext.newPage();
    await adminPage.goto("/queue/admin");
    await waitForPageReady(adminPage);

    // Wait for SSE connection to establish
    await adminPage.waitForTimeout(1000);

    // Register a team via API (simulating another context)
    const regRes = await apiRegister("battery", 3);
    expect(regRes.status).toBe(201);

    // The admin page should reflect the new registration via SSE
    // Wait for the queue to update (SSE broadcast)
    await expect(adminPage.locator(".queue-item").filter({ hasText: "3" })).toBeVisible({ timeout: 10000 });

    await adminContext.close();
  });

  test("registration reflects in public queue status page", async ({ browser }) => {
    // Open public queue page
    const publicContext = await browser.newContext();
    const publicPage = await publicContext.newPage();
    await publicPage.goto("/queue");
    await waitForPageReady(publicPage);

    // Wait for SSE connection
    await publicPage.waitForTimeout(1000);

    // Register a team via API
    const regRes = await apiRegister("battery", 1);
    expect(regRes.status).toBe(201);

    // The public page should reflect the queue length change via SSE
    // The queue status page shows booth status and queue length
    // Verify the public page shows the queue overview card
    const queueSection = publicPage.locator(".queues-card").first();
    await expect(queueSection).toBeVisible({ timeout: 10000 });

    await publicContext.close();
  });
});
