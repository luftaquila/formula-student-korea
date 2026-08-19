import { test, expect } from "@playwright/test";
import {
  dismissNotifications,
  expectNotification,
  waitForPageReady,
} from "../helpers/utils.mjs";

// rank-realtime.spec.mjs owns entries 1-3 on the electric queue in this shard.
// Entry 30 is seeded but never registered by a sibling spec, so its no-queue
// response cannot race another worker's registration or cleanup.
const NO_QUEUE_ENTRY = 30;

test.describe("Queue public status page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);
  });

  test("renders its empty state and gives immediate entry feedback", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /실시간 대기 순번/ })).toBeVisible();
    await expect(page.locator(".result-display")).toContainText("-");

    const entryInput = page.getByPlaceholder("번호");
    await entryInput.fill("1");
    await expect(page.locator(".team-badge").first()).toContainText("서울대학교");

    await entryInput.fill("999");
    await expect(page.locator(".team-badge.error")).toContainText("존재하지 않는 엔트리");
  });

  test("reports exact validation errors for an empty or unknown entry", async ({ page }) => {
    await page.getByRole("button", { name: "조회" }).click();
    await expectNotification(page, "error", "엔트리 번호를 입력하세요");
    await dismissNotifications(page);

    await page.getByPlaceholder("번호").fill("999");
    await page.getByPlaceholder("010-0000-0000").fill("01012345678");
    await page.getByRole("button", { name: "조회" }).click();
    await expectNotification(page, "error", "존재하지 않는 엔트리 번호입니다");
  });

  test("shows the exact no-queue result for a valid unregistered team", async ({ page }) => {
    await page.getByPlaceholder("번호").fill(String(NO_QUEUE_ENTRY));
    await expect(page.locator(".team-badge").first()).toContainText("부산대학교");
    await page.getByPlaceholder("010-0000-0000").fill("01012345678");

    const stateResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/competition/api/v1/queue/state/${NO_QUEUE_ENTRY}`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "조회" }).click();
    expect((await stateResponse).status()).toBe(200);
    await expectNotification(page, "error", "대기중인 검차가 없습니다");
    await expect(page.locator(".result-display")).toContainText("-");
  });
});
