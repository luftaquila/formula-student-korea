import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.describe("Traffic event mode management", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("toggles an event mode off and back on", async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    // Verify navigation has the event tabs initially
    const navTabs = page.locator(".nav-tabs");
    await expect(navTabs).toBeVisible();
    await expect(navTabs).toContainText("짐카나");

    // Find the event mode section on the record page
    const eventModeSection = page.locator(".event-mode-card");
    await expect(eventModeSection).toBeVisible();

    // Click the 짐카나 button to disable it
    const gymkhanaBtn = eventModeSection.locator(".event-mode-btn", { hasText: "짐카나" });
    await expect(gymkhanaBtn).toBeVisible();
    await expect(gymkhanaBtn).not.toHaveClass(/disabled/);
    await gymkhanaBtn.click();

    // Verify the button now has the disabled class
    await expect(gymkhanaBtn).toHaveClass(/disabled/);

    // Verify the nav tab for 짐카나 disappears
    await expect(navTabs).not.toContainText("짐카나");

    // Toggle it back on
    await gymkhanaBtn.click();

    // Verify the button no longer has the disabled class
    await expect(gymkhanaBtn).not.toHaveClass(/disabled/);

    // Verify the nav tab reappears
    await expect(navTabs).toContainText("짐카나");
  });

  test("event mode toggles persist across page navigation", async ({ page }) => {
    await page.goto("/traffic/record");
    await waitForPageReady(page);

    const eventModeSection = page.locator(".event-mode-card");

    // Disable 스키드패드
    const skidpadBtn = eventModeSection.locator(".event-mode-btn", { hasText: "스키드패드" });
    await skidpadBtn.click();
    await expect(skidpadBtn).toHaveClass(/disabled/);

    // Navigate to accel page and back
    const navTabs = page.locator(".nav-tabs");
    await navTabs.locator("a", { hasText: "가속" }).click();
    await waitForPageReady(page);

    // Navigate back to record page
    await navTabs.locator("a", { hasText: "기록" }).click();
    await waitForPageReady(page);

    // Verify 스키드패드 is still disabled
    const skidpadBtnAfter = page.locator(".event-mode-card .event-mode-btn", { hasText: "스키드패드" });
    await expect(skidpadBtnAfter).toHaveClass(/disabled/);

    // Verify nav tab is still hidden
    await expect(navTabs).not.toContainText("스키드패드");

    // Re-enable it to clean up
    await skidpadBtnAfter.click();
    await expect(navTabs).toContainText("스키드패드");
  });
});
