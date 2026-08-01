import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Queue active penalties modal", () => {
  test.use({ storageState: storageStatePath("official") });

  test("lists and clears an active penalty", async ({ page }) => {
    const until = Date.now() + 10 * 60 * 1000;
    let cleared = false;

    await page.route("**/queue/api/admin/penalties**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (request.method() === "GET" && url.pathname.endsWith("/api/admin/penalties")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{
            num: 1,
            inspection: "battery",
            inspection_name: "배터리",
            until,
          }]),
        });
        return;
      }

      if (request.method() === "DELETE" && url.pathname.endsWith("/api/admin/penalties/battery/1")) {
        cleared = true;
        await route.fulfill({ status: 200, body: "" });
        return;
      }

      await route.continue();
    });

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    const statsButton = page.getByRole("button", { name: "통계" });
    const penaltyButton = page.getByRole("button", { name: "페널티", exact: true });
    await expect(statsButton).toBeVisible();
    await expect(penaltyButton).toBeVisible();
    await penaltyButton.click();

    const modal = page.getByRole("dialog", { name: "현재 적용 중인 페널티" });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("#1");
    await expect(modal).toContainText("서울대학교 SNU Racing");
    await expect(modal).toContainText("배터리");
    await expect(modal).toContainText("1건");

    page.once("dialog", (dialog) => dialog.accept());
    await modal.getByRole("button", { name: "페널티 취소" }).click();

    await expectNotification(page, "success", "페널티를 취소했습니다");
    await expect(modal).toContainText("현재 적용 중인 페널티가 없습니다.");
    expect(cleared).toBe(true);
  });

  test("shows an empty state and closes with Escape", async ({ page }) => {
    await page.route("**/queue/api/admin/penalties", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }));

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await page.getByRole("button", { name: "페널티", exact: true }).click();

    const modal = page.getByRole("dialog", { name: "현재 적용 중인 페널티" });
    await expect(modal).toContainText("현재 적용 중인 페널티가 없습니다.");
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
  });
});
