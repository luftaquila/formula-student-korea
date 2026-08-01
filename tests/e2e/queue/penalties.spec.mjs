import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification, dismissNotifications } from "../helpers/utils.mjs";

test.describe("Queue active penalties modal", () => {
  test.use({ storageState: storageStatePath("official") });

  test("offers separate clear-only and clear-with-restore actions", async ({ page }) => {
    const until = Date.now() + 10 * 60 * 1000;
    let cleared = false;
    let restored = false;

    await page.route("**/queue/api/admin/penalties**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (request.method() === "GET" && url.pathname.endsWith("/api/admin/penalties")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              num: 1,
              inspection: "battery",
              inspection_name: "배터리",
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
          ]),
        });
        return;
      }

      if (request.method() === "DELETE" && url.pathname.endsWith("/api/admin/penalties/battery/1")) {
        cleared = true;
        await route.fulfill({ status: 200, body: "" });
        return;
      }

      if (request.method() === "POST" && url.pathname.endsWith("/api/admin/penalties/electric/2/restore")) {
        restored = true;
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
    await expect(modal).toContainText("2건");
    await expect(modal.getByRole("button", { name: "페널티만 해제" })).toHaveCount(2);
    await expect(modal.getByRole("button", { name: "해제 후 순번 복구" })).toHaveCount(2);

    page.once("dialog", (dialog) => dialog.accept());
    await modal.locator(".penalty-item", { hasText: "#1" }).getByRole("button", { name: "페널티만 해제" }).click();

    await expectNotification(page, "success", "페널티를 해제했습니다");
    await expect(modal).toContainText("1건");
    expect(cleared).toBe(true);
    await dismissNotifications(page);

    page.once("dialog", (dialog) => dialog.accept());
    await modal.locator(".penalty-item", { hasText: "#2" }).getByRole("button", { name: "해제 후 순번 복구" }).click();

    await expectNotification(page, "success", "페널티를 해제하고 순번을 복구했습니다");
    await expect(modal).toContainText("현재 적용 중인 페널티가 없습니다.");
    expect(restored).toBe(true);
  });

  test("disables queue restore when legacy penalty data is unavailable", async ({ page }) => {
    await page.route("**/queue/api/admin/penalties", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        num: 1,
        inspection: "battery",
        inspection_name: "배터리",
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

  test("keeps all chief actions on one mobile row with penalty immediately after stats", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("chief") });
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    const registerBox = await page.getByRole("button", { name: "검차 등록" }).boundingBox();
    const priorityBox = await page.getByRole("button", { name: "우선순위" }).boundingBox();
    const statsBox = await page.getByRole("button", { name: "통계" }).boundingBox();
    const penaltyBox = await page.getByRole("button", { name: "페널티", exact: true }).boundingBox();
    expect(registerBox).not.toBeNull();
    expect(priorityBox).not.toBeNull();
    expect(statsBox).not.toBeNull();
    expect(penaltyBox).not.toBeNull();
    expect(Math.abs(registerBox.y - penaltyBox.y)).toBeLessThan(1);
    expect(Math.abs(priorityBox.y - penaltyBox.y)).toBeLessThan(1);
    expect(Math.abs(statsBox.y - penaltyBox.y)).toBeLessThan(1);
    expect(Math.abs(statsBox.height - penaltyBox.height)).toBeLessThan(1);
    expect(penaltyBox.x).toBeGreaterThan(statsBox.x + statsBox.width);
    expect(penaltyBox.x + penaltyBox.width).toBeLessThanOrEqual(390);
    await context.close();
  });
});
