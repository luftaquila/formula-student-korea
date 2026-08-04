import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const PHONE = "01055556666";
const ENTRY_NUM = 95;
const YEAR = new Date().getFullYear();
// This file owns both the entry and inspection type.
const TYPE = "tilting";

test.describe("Queue public status query success flow", () => {
  test.use({ storageState: storageStatePath("chief") });

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const res = await ctx.request.post(`/entry/api/entries?year=${YEAR}`, {
      data: { num: ENTRY_NUM, univ: "E2E Queue Status", team: "Queue Status", type: "EV" },
    });
    expect(res.status()).toBe(201);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const res = await ctx.request.delete(`/entry/api/entries/${ENTRY_NUM}?year=${YEAR}`);
    expect([200, 404]).toContain(res.status());
    await ctx.close();
  });

  test("successful status query shows queue name and rank", async ({ page }) => {
    const regRes = await page.request.post(`/queue/api/admin/register/${TYPE}`, {
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
    } finally {
      await page.request.post(`/queue/api/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/queue/api/admin/booths/${TYPE}/1/exit`);
    }
  });

  test("querying with wrong phone number shows error", async ({ page }) => {
    const regRes = await page.request.post(`/queue/api/admin/register/${TYPE}`, {
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
      await page.request.post(`/queue/api/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/queue/api/admin/booths/${TYPE}/1/exit`);
    }
  });
});
