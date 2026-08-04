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

  test("add, reorder, edit, and remove contacts", async ({ page }) => {
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

    const realname = (await row.locator(".col-realname").textContent()).trim();
    const name = (await row.locator(".col-name").textContent()).trim();
    const expectedName = realname !== "-" ? realname : name !== "-" ? name : optionEmail;

    // Add another contact, then move it above the first one.
    await section.locator(".select-display").click();
    await dropdown.locator(".select-search").fill("e2e");
    const secondOption = dropdown.locator(".select-option").first();
    await expect(secondOption).toBeVisible();
    const secondOptionEmail = await secondOption.locator(".option-email").textContent();
    const secondAddResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "POST");
    await secondOption.click();
    await secondAddResp;

    const secondRow = opsTable.locator("tr").filter({ hasText: secondOptionEmail });
    await expect(secondRow).toBeVisible();
    const secondRealname = (await secondRow.locator(".col-realname").textContent()).trim();
    const secondName = (await secondRow.locator(".col-name").textContent()).trim();
    const expectedSecondName = secondRealname !== "-" ? secondRealname : secondName !== "-" ? secondName : secondOptionEmail;
    const reorderResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts/reorder") && res.request().method() === "POST");
    await secondRow.getByRole("button", { name: `${expectedSecondName} 위로 이동` }).click();
    await reorderResp;
    await expect.poll(async () => (await opsTable.locator("tbody tr td.col-email").allTextContents()).slice(-2)).toEqual([secondOptionEmail, optionEmail]);

    // Warm the sidebar cache before editing to verify that reopening refreshes it
    await page.locator(".menu-btn").click();
    await expect(page.locator(".ops-contact").filter({ hasText: expectedName })).toBeVisible();
    await page.locator(".close-btn").click();

    // Edit the short description shown after the name in the sidebar
    const description = "가".repeat(30);
    const descriptionCell = row.locator(".col-description");
    await descriptionCell.click();
    const descriptionInput = descriptionCell.getByRole("textbox", { name: "운영 연락처 설명" });
    await descriptionInput.fill(description);
    const patchResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts/") && res.request().method() === "PATCH");
    await descriptionInput.press("Enter");
    await patchResp;
    await expect(descriptionCell).toContainText(description);

    // The sidebar renders the contact name before its description
    await page.locator(".menu-btn").click();
    const sidebarContact = page.locator(".ops-contact").filter({ hasText: description });
    const sidebarIdentity = sidebarContact.locator(".ops-contact-identity");
    await expect(sidebarIdentity.locator(".ops-contact-name")).toHaveText(expectedName);
    await expect(sidebarIdentity.locator(".ops-contact-description")).toHaveText(description);
    await expect(sidebarIdentity.locator(":scope > span")).toHaveText([expectedName, description]);
    const sidebarNames = page.locator(".ops-contact-name");
    await expect.poll(async () => (await sidebarNames.allTextContents()).slice(-2)).toEqual([expectedSecondName, expectedName]);
    const drawerHasNoHorizontalOverflow = await page.locator(".drawer").evaluate((drawer) => drawer.scrollWidth <= drawer.clientWidth);
    expect(drawerHasNoHorizontalOverflow).toBe(true);
    await page.locator(".close-btn").click();

    // Remove the user via the 제거 button
    const delResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "DELETE");
    await row.getByRole("button", { name: "제거" }).click();
    await delResp;

    const secondDelResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "DELETE");
    await secondRow.getByRole("button", { name: "제거" }).click();
    await secondDelResp;

    // Verify user is removed from the table
    await expect(row).not.toBeVisible();
    await expect(secondRow).not.toBeVisible();
  });
});
