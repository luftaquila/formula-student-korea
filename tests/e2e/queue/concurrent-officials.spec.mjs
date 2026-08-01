import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "chassis";

async function apiRegister(num) {
  return fetch(`${BASE_URL}/queue/api/admin/register/${INSPECTION_TYPE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiEnterBooth(num, boothNum = 1) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(boothNum = 1) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiGetQueue() {
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${INSPECTION_TYPE}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  return res.json();
}

async function apiSetBoothCount(count) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ count }),
  });
}

async function cleanupQueue() {
  for (let i = 1; i <= 3; i++) {
    await apiExitBooth(i).catch(() => {});
  }
  const queue = await apiGetQueue();
  for (const item of queue) {
    await apiEnterBooth(item.num, 1).catch(() => {});
    await apiExitBooth(1).catch(() => {});
  }
}

test.describe("Concurrent officials simultaneous booth ops", () => {
  let originalPenalty;
  let originalBoothCount;

  test.beforeAll(async () => {
    // Save cancel penalty
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });

    // Get original booth count
    const boothsRes = await fetch(`${BASE_URL}/queue/api/booths/all`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    const booths = await boothsRes.json();
    if (booths[INSPECTION_TYPE]) {
      originalBoothCount = booths[INSPECTION_TYPE].length;
    }

    // Set booth count to 2
    await apiSetBoothCount(2);

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
    if (originalBoothCount) {
      await apiSetBoothCount(originalBoothCount);
    }
  });

  test("two officials see booth updates from each other via SSE", async ({ browser }) => {
    // Register 2 teams
    await apiRegister(10);
    await apiRegister(20);

    // Create two official contexts
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // SSE setup before goto
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/events"));

    await page1.goto("/queue/admin");
    await page2.goto("/queue/admin");

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Switch both to chassis tab
    for (const page of [page1, page2]) {
      const chassisTab = page.locator(".tab").filter({ hasText: "섀시" });
      await expect(chassisTab).toBeVisible({ timeout: 10000 });
      const isActive = await chassisTab.evaluate((el) => el.classList.contains("active"));
      if (!isActive) {
        const queueRefresh = page.waitForResponse((res) => res.url().includes("/api/admin/inspection/") && res.status() === 200);
        await chassisTab.click();
        await queueRefresh;
      }
    }

    // Enter team 10 into booth 1 and team 20 into booth 2 via API
    const enter1 = await apiEnterBooth(10, 1);
    expect(enter1.status).toBe(200);
    const enter2 = await apiEnterBooth(20, 2);
    expect(enter2.status).toBe(200);

    // Both contexts should see both booths occupied via SSE
    for (const page of [page1, page2]) {
      await expect(page.locator(".booth-team-num", { hasText: "10" })).toBeVisible({ timeout: 10000 });
      await expect(page.locator(".booth-team-num", { hasText: "20" })).toBeVisible({ timeout: 10000 });
    }

    // Exit booth 1 via API
    await apiExitBooth(1);

    // Both contexts should see booth 1 freed, booth 2 still occupied
    for (const page of [page1, page2]) {
      await expect(async () => {
        const boothNums = await page.locator(".booth-team-num").allTextContents();
        expect(boothNums.some((t) => t.includes("20"))).toBe(true);
      }).toPass({ timeout: 10000 });
    }

    await context1.close();
    await context2.close();
  });
});
