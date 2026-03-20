import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Use "braking" type exclusively — avoids cleanup collisions with booth-management (battery)
const INSPECTION_TYPE = "braking";

async function apiRegister(num, type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiCancel(num, type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
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

async function apiSetBoothActive(type, boothNum, active) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ active }),
  });
}

async function apiSetBoothCount(type, count) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ count }),
  });
}

async function apiSetVisibility(type, hidden) {
  return fetch(`${BASE_URL}/queue/api/admin/inspection/${type}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ hidden }),
  });
}

async function apiSetIgnore(type, field, value) {
  return fetch(`${BASE_URL}/queue/api/admin/inspection/${type}/ignore`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ field, value }),
  });
}

async function apiClearHistory(type = INSPECTION_TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/history/${type}`, {
    method: "DELETE",
    headers: { Cookie: getAuthCookie("chief") },
  });
}

async function cleanupQueue(type = INSPECTION_TYPE) {
  // Exit all booths first
  for (let i = 1; i <= 3; i++) {
    await apiExitBooth(i, type).catch(() => {});
  }
  // Remove queued entries via booth enter+exit (avoids cancel penalties entirely)
  const queue = await apiGetQueue(type);
  for (const item of queue) {
    await apiEnterBooth(item.num, 1, type).catch(() => {});
    await apiExitBooth(1, type).catch(() => {});
  }
}

test.describe("Queue booth advanced features", () => {
  test.use({ storageState: storageStatePath("chief") });

  let originalPenalty;
  let originalBoothCount;

  test.beforeAll(async () => {
    // Set cancel penalty to 0 for easier testing
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
      await apiSetBoothCount(INSPECTION_TYPE, originalBoothCount);
    }
    await apiSetBoothActive(INSPECTION_TYPE, 1, true);
    await apiSetVisibility("noise", false);
    await apiSetIgnore(INSPECTION_TYPE, "ignore_reinspection", false);
    await apiClearHistory();
  });

  test.beforeEach(async () => {
    await cleanupQueue();
  });

  test.afterEach(async () => {
    await cleanupQueue();
    await apiSetBoothActive(INSPECTION_TYPE, 1, true);
  });

  test("deactivating a booth prevents entry into it", async () => {
    // Deactivate booth 1
    const deactivateRes = await apiSetBoothActive(INSPECTION_TYPE, 1, false);
    expect(deactivateRes.status).toBe(200);

    // Register a team
    await apiRegister(30);

    // Try to enter the deactivated booth
    const enterRes = await apiEnterBooth(30, 1);
    expect(enterRes.status).toBe(400);
    const text = await enterRes.text();
    expect(text).toContain("비활성화된 부스");

    // Re-activate and entry should succeed
    await apiSetBoothActive(INSPECTION_TYPE, 1, true);
    const enterRes2 = await apiEnterBooth(30, 1);
    expect(enterRes2.status).toBe(200);
  });

  test("cannot deactivate an occupied booth", async () => {
    // Register and enter team into booth
    await apiRegister(31);
    await apiEnterBooth(31, 1);

    // Try to deactivate booth 1 (occupied)
    const res = await apiSetBoothActive(INSPECTION_TYPE, 1, false);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("사용 중인 부스");
  });

  test("hidden_from_register hides inspection from registration page", async ({ page }) => {
    // Hide noise inspection from register page
    await apiSetVisibility("noise", true);

    // Visit register page
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // Wait for inspection buttons to load
    await expect(page.locator(".inspection-btn").first()).toBeVisible({ timeout: 10000 });

    // Noise should NOT be visible in the registration buttons
    const buttonTexts = await page.locator(".inspection-btn").allTextContents();
    expect(buttonTexts.some((t) => t.includes("소음"))).toBe(false);

    // But noise should still appear in admin panel tabs
    await page.goto("/queue/admin");
    await waitForPageReady(page);
    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    const tabTexts = await tabs.allTextContents();
    expect(tabTexts.some((t) => t.includes("소음"))).toBe(true);

    // Restore visibility
    await apiSetVisibility("noise", false);
  });

  test("multi-booth concurrent operation with 2 booths", async ({ page }) => {
    // Set booth count to 2
    await apiSetBoothCount(INSPECTION_TYPE, 2);

    // Register 2 teams
    await apiRegister(30);
    await apiRegister(31);

    // Enter team 30 into booth 1 and team 31 into booth 2
    const enter1 = await apiEnterBooth(30, 1);
    expect(enter1.status).toBe(200);
    const enter2 = await apiEnterBooth(31, 2);
    expect(enter2.status).toBe(200);

    // Verify both booths are occupied via admin page
    await page.goto("/queue/admin");
    await waitForPageReady(page);
    const brakingTab = page.locator(".tab", { hasText: "제동" });
    await expect(brakingTab).toBeVisible({ timeout: 10000 });
    await brakingTab.click();

    // Both booth team numbers should be visible
    await expect(page.locator(".booth-team-num", { hasText: "30" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".booth-team-num", { hasText: "31" })).toBeVisible({ timeout: 5000 });

    // Exit both booths
    await apiExitBooth(1);
    await apiExitBooth(2);

    // Restore to original booth count
    if (originalBoothCount) {
      await apiSetBoothCount(INSPECTION_TYPE, originalBoothCount);
    }
  });

  test("re-inspection teams sort after first-time entries", async () => {
    // Ensure reinspection sorting is active (not ignored)
    await apiSetIgnore(INSPECTION_TYPE, "ignore_reinspection", false);
    // Ignore priority to isolate reinspection sorting
    await apiSetIgnore(INSPECTION_TYPE, "ignore_priority", true);
    // Clear any existing history
    await apiClearHistory();

    // Register team 30 and complete inspection (enter + exit booth)
    await apiRegister(30);
    await apiEnterBooth(30, 1);
    await apiExitBooth(1);

    // Re-register team 30 (now it's a re-inspection due to history)
    await apiRegister(30);

    // Register team 31 (first-time inspection)
    await apiRegister(31);

    // Get queue order
    const queue = await apiGetQueue();

    // Team 31 (first-time, is_reinspection=0) should come before
    // team 30 (re-inspection, is_reinspection=1) due to sorting
    expect(queue.length).toBe(2);
    expect(queue[0].num).toBe(31);
    expect(queue[1].num).toBe(30);

    // Restore ignore settings
    await apiSetIgnore(INSPECTION_TYPE, "ignore_priority", false);
  });
});
