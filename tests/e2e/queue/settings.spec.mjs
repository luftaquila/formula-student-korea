import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

async function apiGetCancelPenalty() {
  const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
    headers: { Cookie: getAuthCookie("chief") },
  });
  return res.json();
}

async function apiSetCancelPenalty(value) {
  await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ value }),
  });
}

async function apiGetSmsRank() {
  const res = await fetch(`${BASE_URL}/queue/api/admin/settings/sms-rank`, {
    headers: { Cookie: getAuthCookie("chief") },
  });
  if (!res.ok) throw new Error(`get SMS rank: ${res.status}`);
  return (await res.json()).value;
}

async function apiSetSmsRank(value) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/settings/sms-rank`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ value }),
  });
  if (res.status !== 200) throw new Error(`set SMS rank: ${res.status} ${await res.text()}`);
}

async function apiGetInspections() {
  const res = await fetch(`${BASE_URL}/queue/api/admin/all`, {
    headers: { Cookie: getAuthCookie("chief") },
  });
  return res.json();
}

async function apiSetInspectionActive(type, active) {
  await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
    body: JSON.stringify({ active }),
  });
}

test.describe("Queue settings management", () => {
  test.use({ storageState: storageStatePath("chief") });

  let originalPenalty;
  let originalSmsRank;

  test.beforeAll(async () => {
    const data = await apiGetCancelPenalty();
    originalPenalty = data.value;
    originalSmsRank = await apiGetSmsRank();
  });

  test.afterAll(async () => {
    // Restore original penalty
    if (originalPenalty !== undefined) {
      await apiSetCancelPenalty(originalPenalty);
    }
    if (originalSmsRank !== undefined) {
      await apiSetSmsRank(originalSmsRank);
    }
    // Ensure all inspections are active
    const inspections = await apiGetInspections();
    for (const insp of inspections) {
      if (!insp.active) {
        await apiSetInspectionActive(insp.type, true);
      }
    }
  });

  test("admin page shows settings panel for chief role", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Chief should see the settings panel
    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Should show cancel penalty setting
    await expect(page.getByText("취소 페널티")).toBeVisible();

    // Should show SMS settings
    await expect(page.getByText("SMS 알림 활성화")).toBeVisible();
    await expect(page.getByText("SMS 알림 순번")).toBeVisible();
  });

  test("change cancel penalty setting", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Wait for settings panel to load
    await expect(page.getByText("취소 페널티")).toBeVisible({ timeout: 10000 });

    // Find the cancel penalty input
    const penaltyItem = page.locator(".setting-item", { hasText: "취소 페널티" });
    const penaltyInput = penaltyItem.locator("input[type='number']");
    await expect(penaltyInput).toBeVisible();

    // Pick a different value from current to guarantee save fires
    const currentPenalty = await penaltyInput.inputValue();
    const newPenalty = currentPenalty === "5" ? "7" : "5";

    // Atomically set value and dispatch change to avoid fill()'s two-event issue
    await penaltyInput.evaluate((el, v) => {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, newPenalty);

    // Should show success notification (confirms save succeeded)
    await expectNotification(page, "success", "취소 페널티");
  });

  test("toggle inspection active/inactive via API and verify UI", async ({ page }) => {
    // Deactivate battery inspection via API
    await apiSetInspectionActive("noise", false);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Wait for settings to load
    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // The noise inspection tab should not be visible in the active tabs
    // (only active inspections show as tabs)
    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    const tabTexts = await tabs.allTextContents();
    expect(tabTexts).not.toContain("소음");

    // Re-activate via API
    await apiSetInspectionActive("noise", true);

    // Reload and verify it's back
    await page.reload();
    await waitForPageReady(page);
    await expect(page.locator(".tab").first()).toBeVisible({ timeout: 10000 });

    const updatedTabTexts = await page.locator(".tab").allTextContents();
    expect(updatedTabTexts).toContain("소음");
  });

  test("inspection active/inactive toggle button in settings panel", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Find the inspection setting items in the settings panel
    const inspectionGroups = page.locator(".inspection-setting-group");
    await expect(inspectionGroups.first()).toBeVisible();
    const count = await inspectionGroups.count();
    expect(count).toBe(8); // 8 inspection types

    // Each group should have toggle buttons (visibility and active)
    const firstGroup = inspectionGroups.first();
    const toggleButtons = firstGroup.locator(".inspection-buttons button");
    const btnCount = await toggleButtons.count();
    expect(btnCount).toBe(2); // visibility + active toggle
  });

  test("settings panel not visible for official role", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Official should see the queue panel but NOT the settings panel
    await expect(page.getByRole("heading", { name: /검차 대기열/ })).toBeVisible({ timeout: 10000 });

    // Settings panel should not be visible
    await expect(page.locator(".settings-panel")).not.toBeVisible();

    await context.close();
  });

  test("change booth count and verify persistence", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Find the first booth count input
    const boothInput = page.locator(".inspection-setting .setting-input input[type='number']").first();
    await expect(boothInput).toBeVisible();

    // Read original value
    const originalValue = await boothInput.inputValue();

    // Change the booth count
    const newValue = originalValue === "3" ? "4" : "3";
    await boothInput.fill(newValue);
    await boothInput.dispatchEvent("change");

    // Verify success notification
    await expectNotification(page, "success", "부스");

    // Reload and verify persistence — wait for settings API before asserting
    const settingsLoaded = page.waitForResponse((res) => res.url().includes("/api/admin/all") && res.status() === 200);
    await page.reload();
    await settingsLoaded;
    await waitForPageReady(page);
    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    const updatedInput = page.locator(".inspection-setting .setting-input input[type='number']").first();
    await expect(updatedInput).toHaveValue(newValue);

    // Restore original value
    const restorePromise = page.waitForResponse((res) => res.url().includes("/api/admin/booths/") && res.status() === 200);
    await updatedInput.fill(originalValue);
    await updatedInput.dispatchEvent("change");
    await restorePromise;
  });

  test("deactivated inspection is excluded from public active list", async ({ page }) => {
    // Deactivate noise inspection via API
    await apiSetInspectionActive("noise", false);

    // Verify via public API that noise is not in active list
    const res = await page.request.get("/queue/api/active");
    const active = await res.json();
    const activeTypes = active.map((i) => i.type);
    expect(activeTypes).not.toContain("noise");

    // Re-activate noise inspection
    await apiSetInspectionActive("noise", true);

    // Verify it's back in active list
    const res2 = await page.request.get("/queue/api/active");
    const active2 = await res2.json();
    const activeTypes2 = active2.map((i) => i.type);
    expect(activeTypes2).toContain("noise");
  });

  test("SMS enable fails without config (API level)", async ({ page }) => {
    // SMS enable requires SMS config from email service (not configured in CI)
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/sms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("SMS 설정");

    // Disabling should always work
    const res2 = await fetch(`${BASE_URL}/queue/api/admin/settings/sms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: false }),
    });
    expect(res2.status).toBe(200);
  });

  test("change SMS rank setting", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await expect(page.getByText("SMS 알림 순번")).toBeVisible({ timeout: 10000 });

    // Find the SMS rank input
    const smsRankItem = page.locator(".setting-item", { hasText: "SMS 알림 순번" });
    const rankInput = smsRankItem.locator("input[type='number']");
    await expect(rankInput).toBeVisible();

    // Read original value
    const originalValue = await rankInput.inputValue();

    // Change the rank value
    const newValue = originalValue === "5" ? "3" : "5";
    try {
      const updateResponse = page.waitForResponse(
        (res) => res.url().includes("/api/admin/settings/sms-rank") &&
          res.request().method() === "PATCH" && res.status() === 200,
      );
      await rankInput.fill(newValue);
      await rankInput.dispatchEvent("change");
      await updateResponse;

      await expectNotification(page, "success", `SMS 알림 순번을 ${newValue}번으로 변경했습니다.`);
      await expect.poll(apiGetSmsRank).toBe(Number(newValue));

      // Reload and verify persistence
      await page.reload();
      await waitForPageReady(page);
      await expect(page.getByText("SMS 알림 순번")).toBeVisible({ timeout: 10000 });
      const reloadedInput = page.locator(".setting-item", { hasText: "SMS 알림 순번" }).locator("input[type='number']");
      await expect(reloadedInput).toHaveValue(newValue);
    } finally {
      await apiSetSmsRank(Number(originalValue));
    }
  });

  test("booth count setting is shown in settings panel", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Each inspection setting group should have a booth count input
    const boothInputs = page.locator(".inspection-setting .setting-input input[type='number']");
    await expect(boothInputs.first()).toBeVisible();
    const count = await boothInputs.count();
    expect(count).toBe(8);
  });
});
