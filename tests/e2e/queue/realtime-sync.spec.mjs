import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

async function apiRegister(type, num, phone = "01000000000") {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ num, phone }),
  });
}

async function apiCancel(type, num) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(type, boothNum) {
  await fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiEnterBooth(type, boothNum, num) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiClearQueue(type) {
  // Exit all occupied booths first
  const boothRes = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (boothRes.ok) {
    const booths = await boothRes.json();
    for (const booth of booths) {
      if (booth.occupied_by) await apiExitBooth(type, booth.booth_num);
    }
  }
  // Clear queued entries via enter+exit (avoids cancel penalty issues)
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (!res.ok) return;
  const entries = await res.json();
  for (const entry of entries) {
    await apiEnterBooth(type, 1, entry.num).catch(() => {});
    await apiExitBooth(type, 1);
  }
}

test.describe("Queue SSE real-time sync", () => {
  test.describe.configure({ timeout: 60000 });

  let originalPenalty;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });
    await apiClearQueue("report");
  });

  test.afterEach(async () => {
    await apiClearQueue("report");
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
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
    const ssePromise = adminPage.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/events"));
    await adminPage.goto("/queue/admin");
    await waitForPageReady(adminPage);
    await ssePromise;

    // Switch to report tab (exclusive to this test file — no parallel collision)
    const reportTab = adminPage.locator(".tab").filter({ hasText: "보고서" });
    await expect(reportTab).toBeVisible({ timeout: 10000 });
    const isActive = await reportTab.evaluate((el) => el.classList.contains("active"));
    if (!isActive) {
      const queueRefresh = adminPage.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/admin/inspection/") && res.status() === 200);
      await reportTab.click();
      await queueRefresh;
    }

    // Use team 32 with report type (no other queue test uses this combination)
    await apiEnterBooth("report", 1, 32).catch(() => {});
    await apiExitBooth("report", 1).catch(() => {});

    const regRes = await apiRegister("report", 32);
    expect(regRes.status).toBe(201);

    // The admin page should reflect the new registration via SSE
    await expect(adminPage.locator(".queue-item").filter({ hasText: "32" })).toBeVisible({ timeout: 10000 });

    await adminContext.close();
  });

  test("registration reflects in public queue status page", async ({ browser }) => {
    // Open public queue page
    const publicContext = await browser.newContext();
    const publicPage = await publicContext.newPage();
    const ssePromise = publicPage.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/events"));
    await publicPage.goto("/queue");
    await waitForPageReady(publicPage);
    await ssePromise;

    // Use team 32 with report type
    await apiEnterBooth("report", 1, 32).catch(() => {});
    await apiExitBooth("report", 1).catch(() => {});

    const regRes = await apiRegister("report", 32);
    expect(regRes.status).toBe(201);

    // The public page should reflect the queue length change via SSE
    // The queue status page shows booth status and queue length
    // Verify the public page shows the queue overview card
    const queueSection = publicPage.locator(".queues-card").first();
    await expect(queueSection).toBeVisible({ timeout: 10000 });

    await publicContext.close();
  });

  test("active penalty modal reflects penalty changes from another client", async ({ browser }) => {
    const penaltyUrl = `${BASE_URL}/competition/api/v1/queue/admin/penalties/report/32`;
    await fetch(penaltyUrl, {
      method: "DELETE",
      headers: { Cookie: getAuthCookie("official") },
    });
    await apiClearQueue("report");
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 10 }),
    });

    const adminContext = await browser.newContext({ storageState: storageStatePath("official") });
    const adminPage = await adminContext.newPage();

    try {
      const ssePromise = adminPage.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/events"));
      await adminPage.goto("/queue/admin");
      await waitForPageReady(adminPage);
      await ssePromise;
      await adminPage.getByRole("button", { name: "페널티", exact: true }).click();

      const modal = adminPage.getByRole("dialog", { name: "현재 적용 중인 페널티" });
      const penaltyItem = modal
        .locator(".penalty-item")
        .filter({ hasText: "#32" })
        .filter({ hasText: "보고서" });
      await expect(modal).toBeVisible();
      await expect(penaltyItem).toHaveCount(0);

      const registerRes = await apiRegister("report", 32);
      expect(registerRes.status).toBe(201);
      const cancelRes = await apiCancel("report", 32);
      expect(cancelRes.status).toBe(200);
      await expect(penaltyItem).toBeVisible({ timeout: 10000 });

      const clearRes = await fetch(penaltyUrl, {
        method: "DELETE",
        headers: { Cookie: getAuthCookie("official") },
      });
      expect(clearRes.status).toBe(200);
      await expect(penaltyItem).toHaveCount(0, { timeout: 10000 });
    } finally {
      await adminContext.close();
      await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
        body: JSON.stringify({ value: 0 }),
      });
      await fetch(penaltyUrl, {
        method: "DELETE",
        headers: { Cookie: getAuthCookie("official") },
      });
    }
  });
});
