import { test, expect } from "@playwright/test";
import { storageStatePath, expectNotification, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

const TEST_CONTACT_NAME = "E2E 테스트 담당자";
const TEST_CONTACT_PHONE = "010-1234-5678";

test.describe("Ops contacts management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);
  });

  test("ops contacts section is visible", async ({ page }) => {
    const section = page.locator(".ops-card");
    await expect(section).toBeVisible();
    await expect(section.locator("h3")).toHaveText("운영 오피셜 연락처");
  });

  test("add a new contact", async ({ page }) => {
    const section = page.locator(".ops-card");

    // Fill in contact name and phone
    await section.locator("input[placeholder='이름']").fill(TEST_CONTACT_NAME);
    await section.locator("input[placeholder='전화번호']").fill(TEST_CONTACT_PHONE);

    // Submit
    await section.locator("button").filter({ hasText: "추가" }).click();

    // Verify success notification
    await expectNotification(page, "success", "연락처를 추가했습니다");

    // Verify the contact appears in the list
    await expect(section.locator(".ops-name").filter({ hasText: TEST_CONTACT_NAME })).toBeVisible();
  });

  test("delete a contact", async ({ page }) => {
    const section = page.locator(".ops-card");

    // Find the contact item we added
    const contactItem = section.locator(".ops-item").filter({ hasText: TEST_CONTACT_NAME });
    await expect(contactItem).toBeVisible();

    // Click delete
    await contactItem.getByRole("button", { name: "삭제" }).click();

    // Verify the contact is removed from the list
    await expect(section.locator(".ops-name").filter({ hasText: TEST_CONTACT_NAME })).not.toBeVisible();
  });
});
