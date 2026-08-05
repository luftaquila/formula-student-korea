import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear() - 8;
const TEAM_NUM = 81;

test.describe("Entry active-state toggle", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.post(`/entry/api/entries?year=${YEAR}`, {
      data: { num: TEAM_NUM, univ: "상태대학교", team: "상태팀" },
    });
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/entry/api/entries?year=${YEAR}`);
    await context.close();
  });

  test("updates only the target row without refetching the table", async ({ page }) => {
    await page.request.patch(`/entry/api/entries/${TEAM_NUM}/active?year=${YEAR}`, {
      data: { active: true },
    });
    await page.goto("/entry");
    await waitForPageReady(page);
    await page.locator(".year-select").selectOption(String(YEAR));
    await waitForPageReady(page);

    let listFetches = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/entry/api/entries") listFetches += 1;
    });

    const row = page.locator(".entry-table tbody tr").filter({ hasText: "상태대학교" });
    const toggle = row.locator(".status-toggle");
    await expect(toggle).toHaveText("");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    page.on("dialog", (dialog) => dialog.accept());
    await toggle.click();
    await expectNotification(page, "success", "비활성화했습니다");

    await expect(row).toHaveClass(/entry-inactive/);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".entry-count")).toHaveText("0대");
    expect(listFetches).toBe(0);

    await toggle.click();
    await expectNotification(page, "success", "활성화했습니다");

    await expect(row).not.toHaveClass(/entry-inactive/);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".entry-count")).toHaveText("1대");
    expect(listFetches).toBe(0);
  });
});
