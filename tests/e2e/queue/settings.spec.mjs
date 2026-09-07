import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const SETTINGS_TYPE = "battery";

async function apiGetSettings(type = SETTINGS_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/${type}`, {
    headers: { Cookie: getAuthCookie("operationsManager") },
  });
  return res.json();
}

async function apiSetSettings(settings, type = SETTINGS_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/${type}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`set inspection settings: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiGetInspections() {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/all`, {
    headers: { Cookie: getAuthCookie("operationsManager") },
  });
  return res.json();
}

async function apiSetInspectionActive(type, active) {
  await fetch(`${BASE_URL}/competition/api/v1/queue/admin/inspection/${type}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
    body: JSON.stringify({ active }),
  });
}

test.describe("Queue settings management", () => {
  test.use({ storageState: storageStatePath("operationsManager") });

  let originalSettings;

  test.beforeAll(async () => {
    originalSettings = await apiGetSettings();
  });

  test.afterAll(async () => {
    if (originalSettings) await apiSetSettings(originalSettings);
    // Ensure all inspections are active
    const inspections = await apiGetInspections();
    for (const insp of inspections) {
      if (!insp.active) {
        await apiSetInspectionActive(insp.type, true);
      }
    }
  });

  test("admin settings button opens per-inspection settings above priorities", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.locator(".top-actions .btn")).toHaveText([
      "검차 등록",
      "페널티",
      "통계",
      "설정",
    ]);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page).toHaveURL(/\/queue\/settings/);

    const settingsHeading = page.getByRole("heading", { name: "검차별 설정", exact: true });
    const priorityHeading = page.getByRole("heading", { name: "우선순위 설정", exact: true });
    await expect(settingsHeading).toBeVisible({ timeout: 10000 });
    await expect(priorityHeading).toBeVisible();
    const headings = await page.getByRole("heading").allTextContents();
    expect(headings.indexOf("검차별 설정")).toBeLessThan(headings.indexOf("우선순위 설정"));

    const batterySettings = page.locator(".inspection-setting-group", { hasText: "축전지" });
    await expect(batterySettings.getByText("취소 페널티")).toBeVisible();
    await expect(batterySettings.getByText("SMS 알림", { exact: true })).toBeVisible();
    await expect(batterySettings.getByText("SMS 알림 순번")).toBeVisible();
  });

  test("change cancel penalty setting", async ({ page }) => {
    await page.goto("/queue/settings");
    await waitForPageReady(page);

    // Wait for the per-inspection settings to load.
    const batterySettings = page.locator(".inspection-setting-group", { hasText: "축전지" });
    await expect(batterySettings.getByText("취소 페널티")).toBeVisible({ timeout: 10000 });

    // Find the cancel penalty input
    const penaltyItem = batterySettings.locator(".setting-item", { hasText: "취소 페널티" });
    const penaltyInput = penaltyItem.locator("input[type='number']");
    await expect(penaltyInput).toBeVisible();

    // Pick a different value from current to guarantee save fires
    const currentPenalty = await penaltyInput.inputValue();
    const newPenalty = currentPenalty === "5" ? "7" : "5";

    await penaltyInput.click();
    await penaltyInput.fill(newPenalty);
    await penaltyInput.blur();

    // Should show success notification (confirms save succeeded)
    await expectNotification(page, "success", "취소 페널티");
  });

  test("toggle inspection active/inactive via API and verify UI", async ({ page }) => {
    // Deactivate battery inspection via API
    await apiSetInspectionActive("noise", false);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

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

  test("inspection active/inactive toggle button in settings page", async ({ page }) => {
    await page.goto("/queue/settings");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Find the inspection setting cards on the settings page.
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

  test("settings navigation is unavailable to an official role", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const page = await context.newPage();

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Official should see the queue panel but not the management-only settings entry.
    await expect(page.getByRole("heading", { name: /검차 대기열/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "설정", exact: true })).not.toBeVisible();

    await page.goto("/queue/settings");
    await expect(page).not.toHaveURL(/\/queue\/settings/);

    await context.close();
  });

  test("change booth count and verify persistence", async ({ page }) => {
    await page.goto("/queue/settings");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Find the first booth count input
    const boothInput = page.locator(".booth-setting input[type='number']").first();
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
    const settingsLoaded = page.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/admin/all") && res.status() === 200);
    await page.reload();
    await settingsLoaded;
    await waitForPageReady(page);
    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    const updatedInput = page.locator(".booth-setting input[type='number']").first();
    await expect(updatedInput).toHaveValue(newValue);

    // Restore original value
    const restorePromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/admin/booths/") && res.status() === 200);
    await updatedInput.fill(originalValue);
    await updatedInput.dispatchEvent("change");
    await restorePromise;
  });

  test("deactivated inspection is excluded from public active list", async ({ page }) => {
    // Deactivate noise inspection via API
    await apiSetInspectionActive("noise", false);

    // Verify via public API that noise is not in active list
    const res = await page.request.get("/competition/api/v1/queue/active");
    const active = await res.json();
    const activeTypes = active.map((i) => i.type);
    expect(activeTypes).not.toContain("noise");

    // Re-activate noise inspection
    await apiSetInspectionActive("noise", true);

    // Verify it's back in active list
    const res2 = await page.request.get("/competition/api/v1/queue/active");
    const active2 = await res2.json();
    const activeTypes2 = active2.map((i) => i.type);
    expect(activeTypes2).toContain("noise");
  });

  test("SMS enable fails without config (API level)", async ({ page }) => {
    // SMS enable requires SMS config from email service (not configured in CI)
    const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/${SETTINGS_TYPE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ sms: true }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("SMS 설정");

    // Disabling should always work
    const res2 = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/${SETTINGS_TYPE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ sms: false }),
    });
    expect(res2.status).toBe(200);
  });

  test("change SMS rank setting", async ({ page }) => {
    await page.goto("/queue/settings");
    await waitForPageReady(page);
    const batterySettings = page.locator(".inspection-setting-group", { hasText: "축전지" });
    await expect(batterySettings.getByText("SMS 알림 순번")).toBeVisible({ timeout: 10000 });

    // Find the SMS rank input
    const smsRankItem = batterySettings.locator(".setting-item", { hasText: "SMS 알림 순번" });
    const rankInput = smsRankItem.locator("input[type='number']");
    await expect(rankInput).toBeVisible();

    // Read original value
    const originalValue = await rankInput.inputValue();

    // Change the rank value
    const newValue = originalValue === "5" ? "3" : "5";
    try {
      const updateResponse = page.waitForResponse(
        (res) => res.url().includes(`/competition/api/v1/queue/admin/settings/${SETTINGS_TYPE}`) &&
          res.request().method() === "PATCH" && res.status() === 200,
      );
      await rankInput.fill(newValue);
      await rankInput.dispatchEvent("change");
      await updateResponse;

      await expectNotification(page, "success", `SMS 알림 순번을 ${newValue}번으로 변경했습니다.`);
      await expect.poll(async () => (await apiGetSettings()).smsRank).toBe(Number(newValue));

      // Reload and verify persistence
      await page.reload();
      await waitForPageReady(page);
      const reloadedBatterySettings = page.locator(".inspection-setting-group", { hasText: "축전지" });
      await expect(reloadedBatterySettings.getByText("SMS 알림 순번")).toBeVisible({ timeout: 10000 });
      const reloadedInput = reloadedBatterySettings.locator(".setting-item", { hasText: "SMS 알림 순번" }).locator("input[type='number']");
      await expect(reloadedInput).toHaveValue(newValue);
    } finally {
      await apiSetSettings({ smsRank: Number(originalValue) });
    }
  });

  test("booth count setting is shown in each inspection card", async ({ page }) => {
    await page.goto("/queue/settings");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /설정/ })).toBeVisible({ timeout: 10000 });

    // Each inspection setting group should have a booth count input
    const boothInputs = page.locator(".booth-setting input[type='number']");
    await expect(boothInputs.first()).toBeVisible();
    const count = await boothInputs.count();
    expect(count).toBe(8);
  });
});
