import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

test.describe("Ops contacts management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);
  });

  test("ops contacts section is visible with description", async ({ page }) => {
    const section = page.locator(".ops-card");
    await expect(section).toBeVisible();
    await expect(section.locator("h3")).toHaveText("운영 오피셜 연락처");
    await expect(section.locator(".ops-desc")).toContainText("사이드바에 표시");
  });

  test("add and remove user via dropdown", async ({ page }) => {
    const section = page.locator(".ops-card");

    // Open dropdown
    await section.locator(".select-display").click();
    const dropdown = section.locator(".select-dropdown");
    await expect(dropdown).toBeVisible();

    // Search for a user
    await dropdown.locator(".select-search").fill("e2e");

    // Select the first option
    const firstOption = dropdown.locator(".select-option").first();
    await expect(firstOption).toBeVisible();
    const optionEmail = await firstOption.locator(".option-email").textContent();

    const addResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "POST");
    await firstOption.click();
    await addResp;

    // Verify user appears in the ops table
    const opsTable = section.locator("table.ops-table");
    const row = opsTable.locator("tr").filter({ hasText: optionEmail });
    await expect(row).toBeVisible();

    // Remove the user via the 제거 button
    const delResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "DELETE");
    await row.getByRole("button", { name: "제거" }).click();
    await delResp;

    // Verify user is removed from the table
    await expect(row).not.toBeVisible();
  });
});
