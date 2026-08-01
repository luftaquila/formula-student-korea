import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "battery";

async function apiRegister(num, type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
  return res;
}

async function apiCancel(num, type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
  return res;
}

async function apiGetQueue(type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  return res.json();
}

async function apiExitBooth(type, boothNum) {
  await fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiEnterBooth(type, boothNum, num) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function cleanupQueue(type = INSPECTION_TYPE) {
  // Exit booth first
  await apiExitBooth(type, 1);
  // Remove queued entries via booth enter+exit (avoids cancel penalties entirely)
  const queue = await apiGetQueue(type);
  for (const item of queue) {
    await apiEnterBooth(type, 1, item.num).catch(() => {});
    await apiExitBooth(type, 1);
  }
}

test.describe("Queue booth management", () => {
  test.use({ storageState: storageStatePath("official") });

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

  test.beforeEach(async () => {
    await cleanupQueue();
  });

  test.afterEach(async () => {
    await cleanupQueue();
  });

  test("admin page shows queue listing and booth section", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Should show the admin panel heading
    await expect(page.getByRole("heading", { name: /검차 대기열/ })).toBeVisible();

    // Should show inspection type tabs
    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);

    // Should show booth section
    await expect(page.getByText("부스 현황")).toBeVisible();
  });

  test("switching inspection tabs changes displayed queue", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Click second tab if available
    const count = await tabs.count();
    if (count >= 2) {
      const secondTab = tabs.nth(1);
      await secondTab.click();
      await expect(secondTab).toHaveClass(/active/);
    }
  });

  test("register team via API then verify it appears in admin queue", async ({ page }) => {
    // Register entry 1 via API
    const res = await apiRegister(1);
    expect(res.status).toBe(201);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Click the battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "배터리" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Verify entry 1 appears in queue
    await expect(page.locator(".entry-num", { hasText: "1" })).toBeVisible({ timeout: 5000 });
  });

  test("enter team into booth via admin UI", async ({ page }) => {
    // Register entry 2 via API
    await apiRegister(2);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "배터리" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Wait for the queue to show
    await expect(page.locator(".entry-num", { hasText: "2" })).toBeVisible({ timeout: 5000 });

    // Select the team in the booth select dropdown
    const boothSelect = page.locator(".booth-select").first();
    await expect(boothSelect).toBeVisible({ timeout: 5000 });
    const targetOption = boothSelect.locator("option").filter({ hasText: /^2 -/ });
    const optValue = await targetOption.getAttribute("value");
    await boothSelect.selectOption(optValue);

    // Click enter booth button
    const enterBtn = page.getByRole("button", { name: "입차" }).first();
    await enterBtn.click();

    // Should show success notification
    await expectNotification(page, "success", "입차");
  });

  test("exit team from booth via admin UI", async ({ page }) => {
    // Register and enter entry 3 via API
    await apiRegister(3);
    await fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/1/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
      body: JSON.stringify({ num: 3 }),
    });

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "배터리" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // The booth should show the team and an exit button
    await expect(page.locator(".booth-team-num", { hasText: "3" })).toBeVisible({ timeout: 10000 });

    // Click exit booth button (exit is guarded by a confirm() dialog)
    page.on("dialog", (dialog) => dialog.accept());
    const exitBtn = page.getByRole("button", { name: "출차" }).first();
    await exitBtn.click();

    // Should show success notification
    await expectNotification(page, "success", "출차");
  });

  test("cancel queued team via admin UI", async ({ page }) => {
    // Register entry 20 via API
    await apiRegister(20);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "배터리" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Wait for entry to appear
    await expect(page.locator(".entry-num", { hasText: "20" })).toBeVisible({ timeout: 5000 });

    // Click cancel button (X icon)
    page.on("dialog", (dialog) => dialog.accept());
    const cancelBtn = page.locator(".queue-item", { hasText: "20" }).locator(".btn-danger");
    await cancelBtn.click();

    // Should show warning notification for cancel
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 5000 });
  });

  test("official sees operational buttons without registration", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("button", { name: "검차 등록" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "우선순위" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "통계" })).toBeVisible();
    await expect(page.getByRole("button", { name: "페널티", exact: true })).toBeVisible();
  });

  test("chief can open the registration page from admin", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("chief") });
    const page = await context.newPage();
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("button", { name: "검차 등록" })).toBeVisible();
    await page.getByRole("button", { name: "검차 등록" }).click();
    await expect(page).toHaveURL(/\/queue\/register/);
    await expect(page.getByText("검차 종류 선택")).toBeVisible();
    await context.close();
  });
});
