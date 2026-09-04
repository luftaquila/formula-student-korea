import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, expectNotificationAfter } from "../helpers/utils.mjs";

test.describe("Queue active penalties modal", () => {
  test.use({ storageState: storageStatePath("operationsOperator") });

  test("offers separate clear-only and clear-with-restore actions", async ({ page }) => {
    const until = Date.now() + 10 * 60 * 1000;
    let cleared = false;
    let restored = false;
    let penalties = [
      {
        num: 1,
        inspection: "battery",
        inspection_name: "축전지",
        until,
        can_restore: 1,
      },
      {
        num: 2,
        inspection: "electric",
        inspection_name: "전기",
        until: until + 60000,
        can_restore: 1,
      },
    ];

    await page.route("**/competition/api/v1/queue/admin/penalties**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (request.method() === "GET" && url.pathname.endsWith("/competition/api/v1/queue/admin/penalties")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(penalties),
        });
        return;
      }

      if (request.method() === "DELETE" && url.pathname.endsWith("/competition/api/v1/queue/admin/penalties/battery/1")) {
        cleared = true;
        penalties = penalties.filter((penalty) => penalty.num !== 1 || penalty.inspection !== "battery");
        await route.fulfill({ status: 200, body: "" });
        return;
      }

      if (request.method() === "POST" && url.pathname.endsWith("/competition/api/v1/queue/admin/penalties/electric/2/restore")) {
        restored = true;
        penalties = penalties.filter((penalty) => penalty.num !== 2 || penalty.inspection !== "electric");
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
    await expect(modal).toContainText("축전지");
    await expect(modal).toContainText("2건");
    await expect(modal.getByRole("button", { name: "페널티만 해제" })).toHaveCount(2);
    await expect(modal.getByRole("button", { name: "해제 후 순번 복구" })).toHaveCount(2);

    page.once("dialog", (dialog) => dialog.accept());
    await modal.locator(".penalty-item", { hasText: "#1" }).getByRole("button", { name: "페널티만 해제" }).click();

    await expectNotification(page, "success", "페널티를 해제했습니다");
    await expect(modal).toContainText("1건");
    expect(cleared).toBe(true);

    page.once("dialog", (dialog) => dialog.accept());
    await expectNotificationAfter(
      page,
      "success",
      "페널티를 해제하고 순번을 복구했습니다",
      () => modal.locator(".penalty-item", { hasText: "#2" }).getByRole("button", { name: "해제 후 순번 복구" }).click(),
    );
    await expect(modal).toContainText("현재 적용 중인 페널티가 없습니다.");
    expect(restored).toBe(true);
  });

  test("disables queue restore when legacy penalty data is unavailable", async ({ page }) => {
    await page.route("**/competition/api/v1/queue/admin/penalties", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        num: 1,
        inspection: "battery",
        inspection_name: "축전지",
        until: Date.now() + 10 * 60 * 1000,
        can_restore: 0,
      }]),
    }));

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await page.getByRole("button", { name: "페널티", exact: true }).click();

    const modal = page.getByRole("dialog", { name: "현재 적용 중인 페널티" });
    await expect(modal).toContainText("순번 복구 정보 없음");
    await expect(modal.getByRole("button", { name: "페널티만 해제" })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "해제 후 순번 복구" })).toBeDisabled();
  });

  test("shows an empty state and closes with Escape", async ({ page }) => {
    await page.route("**/competition/api/v1/queue/admin/penalties", (route) => route.fulfill({
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
