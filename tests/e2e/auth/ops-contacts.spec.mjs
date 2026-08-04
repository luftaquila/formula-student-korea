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

async function clearOpsContacts(page) {
  const listResponse = await page.request.get("/auth/api/ops-contacts");
  expect(listResponse.ok()).toBe(true);
  for (const contact of await listResponse.json()) {
    const deleteResponse = await page.request.delete(`/auth/api/ops-contacts/${contact.id}`);
    expect(deleteResponse.ok()).toBe(true);
  }
}

test.describe("Ops contacts management", () => {
  test.beforeEach(async ({ page }) => {
    await clearOpsContacts(page);
    await page.goto("/auth");
    await waitForPageReady(page);
  });

  test.afterEach(async ({ page }) => {
    await clearOpsContacts(page);
  });

  test("ops contacts section is visible with description", async ({ page }) => {
    const section = page.locator(".ops-card");
    await expect(section).toBeVisible();
    await expect(section.locator("h3")).toHaveText("운영 오피셜 연락처");
    await expect(section.locator(".ops-desc")).toContainText("사이드바에 표시");
  });

  test("adds, edits, and removes a contact", async ({ page }) => {
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
    const drawerHasNoHorizontalOverflow = await page.locator(".drawer").evaluate((drawer) => drawer.scrollWidth <= drawer.clientWidth);
    expect(drawerHasNoHorizontalOverflow).toBe(true);
    await page.locator(".close-btn").click();

    // Remove the user via the 제거 button
    const delResp = page.waitForResponse((res) => res.url().includes("/api/ops-contacts") && res.request().method() === "DELETE");
    await row.getByRole("button", { name: "제거" }).click();
    await delResp;

    // Verify user is removed from the table
    await expect(row).not.toBeVisible();
  });

  test("reorders contacts only from the handle with mouse and touch", async ({ page }) => {
    const usersResponse = await page.request.get("/auth/api/users");
    expect(usersResponse.ok()).toBe(true);
    const contacts = (await usersResponse.json())
      .filter((user) => user.active && ["official", "chief", "admin"].includes(user.role))
      .slice(0, 2);
    expect(contacts).toHaveLength(2);

    for (const contact of contacts) {
      const addResponse = await page.request.post("/auth/api/ops-contacts", { data: { user_id: contact.id } });
      expect(addResponse.ok()).toBe(true);
    }
    await page.reload();
    await waitForPageReady(page);

    const section = page.locator(".ops-card");
    const opsTable = section.locator("table.ops-table");
    const [firstContact, secondContact] = contacts;
    const firstRow = opsTable.locator("tbody tr").filter({ hasText: firstContact.email });
    const secondRow = opsTable.locator("tbody tr").filter({ hasText: secondContact.email });
    const firstLabel = firstContact.realname || firstContact.name || firstContact.email;
    const secondLabel = secondContact.realname || secondContact.name || secondContact.email;
    const visibleEmails = async () => opsTable.locator("tbody tr td.col-email").allTextContents();
    let reorderRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/ops-contacts/reorder") && request.method() === "POST") reorderRequests++;
    });

    await test.step("regular cells do not start a reorder", async () => {
      await dragWithMouse(page, secondRow.locator(".col-email"), firstRow);
      await expect.poll(visibleEmails).toEqual([firstContact.email, secondContact.email]);
      expect(reorderRequests).toBe(0);
    });

    await test.step("the handle reorders with a desktop mouse", async () => {
      const reorderResponse = page.waitForResponse((response) => response.url().includes("/api/ops-contacts/reorder") && response.request().method() === "POST");
      await dragWithMouse(page, secondRow.getByRole("button", { name: `${secondLabel} 드래그하여 순서 변경` }), firstRow);
      await reorderResponse;
      await expect.poll(visibleEmails).toEqual([secondContact.email, firstContact.email]);
    });

    await test.step("the handle reorders with touch in a mobile viewport", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const reorderResponse = page.waitForResponse((response) => response.url().includes("/api/ops-contacts/reorder") && response.request().method() === "POST");
      await dragWithTouch(page, firstRow.getByRole("button", { name: `${firstLabel} 드래그하여 순서 변경` }), secondRow);
      await reorderResponse;
      await expect.poll(visibleEmails).toEqual([firstContact.email, secondContact.email]);
    });

    await test.step("the sidebar uses the saved order", async () => {
      await page.locator(".menu-btn").click();
      await expect(page.locator(".ops-contact-name")).toHaveText([firstLabel, secondLabel]);
    });
  });
});
