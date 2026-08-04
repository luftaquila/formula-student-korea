import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.use({ storageState: storageStatePath("admin") });

async function dragWithMouse(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function dragWithTouch(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  const x = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endY = targetBox.y + targetBox.height / 2;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 8; step++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: startY + ((endY - startY) * step) / 8 }],
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
  }
}

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
    // Dragging a regular cell does nothing; only the handle starts a reorder.
    await dragWithMouse(page, secondRow.locator(".col-email"), row);
    await expect.poll(async () => (await opsTable.locator("tbody tr td.col-email").allTextContents()).slice(-2)).toEqual([optionEmail, secondOptionEmail]);

    // Desktop mouse drag.
    const mouseReorderResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts/reorder") && res.request().method() === "POST");
    await dragWithMouse(page, secondRow.getByRole("button", { name: `${expectedSecondName} 드래그하여 순서 변경` }), row);
    await mouseReorderResp;
    await expect.poll(async () => (await opsTable.locator("tbody tr td.col-email").allTextContents()).slice(-2)).toEqual([secondOptionEmail, optionEmail]);

    // Mobile-sized viewport and emulated touch drag.
    await page.setViewportSize({ width: 390, height: 844 });
    const touchReorderResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts/reorder") && res.request().method() === "POST");
    await dragWithTouch(page, row.getByRole("button", { name: `${expectedName} 드래그하여 순서 변경` }), secondRow);
    await touchReorderResp;
    await expect.poll(async () => (await opsTable.locator("tbody tr td.col-email").allTextContents()).slice(-2)).toEqual([optionEmail, secondOptionEmail]);

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
    await expect.poll(async () => (await sidebarNames.allTextContents()).slice(-2)).toEqual([expectedName, expectedSecondName]);
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
