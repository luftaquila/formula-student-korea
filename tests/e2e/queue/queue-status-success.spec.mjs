import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const PHONE = "01055556666";
const ENTRY_NUM = 95;
// This file owns the inspection type and uses its dedicated seeded entry.
const TYPE = "tilting";

test.describe("Queue public status query success flow", () => {
  test.use({ storageState: storageStatePath("chief") });

  test("successful status query shows queue name and rank", async ({ page }) => {
    const regRes = await page.request.post(`/competition/api/v1/queue/admin/register/${TYPE}`, {
      data: { num: ENTRY_NUM, phone: PHONE },
    });
    expect(regRes.status()).toBe(201);

    try {
      await page.goto("/queue");
      await waitForPageReady(page);

      const entryInput = page.getByPlaceholder("번호");
      await entryInput.fill(String(ENTRY_NUM));
      await entryInput.dispatchEvent("input");

      await expect(page.locator(".team-badge").first()).toContainText("E2E Queue Status");

      const phoneInput = page.getByPlaceholder("010-0000-0000");
      await phoneInput.fill(PHONE);

      await page.getByRole("button", { name: "조회" }).click();

      const resultRow = page.locator(".result-row");
      await expect(resultRow.first()).toBeVisible({ timeout: 5000 });
      await expect(resultRow.first().locator(".result-rank")).toBeVisible();
      await expect(resultRow.first().locator(".result-total")).toContainText(/^\/ \d+팀$/);
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });

  test("querying with wrong phone number shows error", async ({ page }) => {
    const regRes = await page.request.post(`/competition/api/v1/queue/admin/register/${TYPE}`, {
      data: { num: ENTRY_NUM, phone: PHONE },
    });
    expect(regRes.status()).toBe(201);

    try {
      await page.goto("/queue");
      await waitForPageReady(page);

      const entryInput = page.getByPlaceholder("번호");
      await entryInput.fill(String(ENTRY_NUM));

      const phoneInput = page.getByPlaceholder("010-0000-0000");
      await phoneInput.fill("01099999999");

      await page.getByRole("button", { name: "조회" }).click();

      await expect(page.locator("[data-sonner-toast][data-type='error']").first()).toBeVisible({ timeout: 5000 });
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });
});
