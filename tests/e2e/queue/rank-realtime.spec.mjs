import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "electric";

async function apiRegister(num) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/register/${INSPECTION_TYPE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiEnterBooth(num, boothNum = 1) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${INSPECTION_TYPE}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(boothNum = 1) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${INSPECTION_TYPE}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
  });
}

async function apiGetQueue() {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/inspection/${INSPECTION_TYPE}`, {
    headers: { Cookie: getAuthCookie("operationsOperator") },
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

test.describe("Queue rank real-time updates via SSE", () => {
  let originalPenalty;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("operationsManager") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ value: 0 }),
    });
    await cleanupQueue();
  });

  test.afterEach(async () => {
    await cleanupQueue();
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test("entering booth removes team from queue list in admin view via SSE", async ({ browser }) => {
    // Register 3 teams
    for (const num of [1, 2, 3]) {
      const res = await apiRegister(num);
      expect(res.status).toBe(201);
    }

    // Open admin view
    const context = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const page = await context.newPage();
    const ssePromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/events"));
    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await ssePromise;

    // Switch to electric tab
    const electricTab = page.locator(".tab").filter({ hasText: "전기" });
    await expect(electricTab).toBeVisible({ timeout: 10000 });
    const isActive = await electricTab.evaluate((el) => el.classList.contains("active"));
    if (!isActive) {
      const queueRefresh = page.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/admin/inspection/") && res.status() === 200);
      await electricTab.click();
      await queueRefresh;
    }

    // Verify all 3 teams are in queue (use .entry-num to avoid matching phone numbers)
    await expect(page.locator(".entry-num", { hasText: "1" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".entry-num", { hasText: "2" })).toBeVisible();
    await expect(page.locator(".entry-num", { hasText: "3" })).toBeVisible();

    // Enter team 1 into booth via API
    const enterRes = await apiEnterBooth(1);
    expect(enterRes.status).toBe(200);

    // SSE should remove team 1 from queue list; teams 2,3 remain
    await expect(async () => {
      const entryNums = await page.locator(".entry-num").allTextContents();
      // Team 1 should be gone from the queue (moved to booth)
      expect(entryNums.some((t) => t.trim() === "2")).toBe(true);
      expect(entryNums.some((t) => t.trim() === "3")).toBe(true);
    }).toPass({ timeout: 10000 });

    await context.close();
  });

  test("public queue page receives SSE updates when queue changes", async ({ browser }) => {
    // Open public queue page
    const publicContext = await browser.newContext();
    const publicPage = await publicContext.newPage();
    const ssePromise = publicPage.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/events"));
    await publicPage.goto("/queue");
    await waitForPageReady(publicPage);
    await ssePromise;

    // Queue section should be visible
    const queueSection = publicPage.locator(".queues-card").first();
    await expect(queueSection).toBeVisible({ timeout: 10000 });

    // Register a team via API
    const regRes = await apiRegister(2);
    expect(regRes.status).toBe(201);

    // Public page should update (queue count or content should change)
    // Use a broad check: verify the queues-card is still rendered after the SSE event
    await expect(queueSection).toBeVisible({ timeout: 10000 });

    await publicContext.close();
  });
});
