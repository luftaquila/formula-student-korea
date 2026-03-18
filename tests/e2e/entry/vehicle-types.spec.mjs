import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Vehicle type management", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);
  });

  test("adds a new vehicle type", async ({ page }) => {
    const manager = page.locator(".sidebar .card").filter({ hasText: "차량 유형 관리" });

    // Verify initial state: EV and CV should exist from seed
    const typeList = manager.locator(".type-list");
    await expect(typeList.locator(".type-item")).toHaveCount(2);
    await expect(typeList).toContainText("EV");
    await expect(typeList).toContainText("CV");

    // Add a new vehicle type
    await manager.locator('input[type="text"]').fill("HEV");
    await manager.locator("button.add-btn").click();

    // Verify success notification
    await expectNotification(page, "success", "차량 유형 'HEV'을(를) 추가했습니다.");

    // Verify the new type appears in the list
    await waitForPageReady(page);
    await expect(typeList.locator(".type-item")).toHaveCount(3);
    await expect(typeList).toContainText("HEV");

    // Verify input field is cleared after adding
    await expect(manager.locator('input[type="text"]')).toHaveValue("");

    // Clean up: delete the type we just added
    page.on("dialog", (dialog) => dialog.accept());
    const hevItem = typeList.locator(".type-item").filter({ hasText: "HEV" });
    await hevItem.locator(".delete-btn").click();
    await waitForPageReady(page);
  });

  test("deletes a vehicle type", async ({ page }) => {
    const manager = page.locator(".sidebar .card").filter({ hasText: "차량 유형 관리" });
    const typeList = manager.locator(".type-list");

    // First, add a temporary type to delete
    await manager.locator('input[type="text"]').fill("TEMP");
    await manager.locator("button.add-btn").click();
    await waitForPageReady(page);
    await expect(typeList.locator(".type-item")).toHaveCount(3);

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Delete the TEMP type
    const tempItem = typeList.locator(".type-item").filter({ hasText: "TEMP" });
    await tempItem.locator(".delete-btn").click();

    // Verify success notification
    await expectNotification(page, "success", "차량 유형을 삭제했습니다.");

    // Verify the type is removed from the list
    await waitForPageReady(page);
    await expect(typeList.locator(".type-item")).toHaveCount(2);
    await expect(typeList).not.toContainText("TEMP");

    // Verify original types still exist
    await expect(typeList).toContainText("EV");
    await expect(typeList).toContainText("CV");
  });
});
