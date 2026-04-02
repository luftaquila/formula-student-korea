import { test, expect } from "@playwright/test";
import { waitForPageReady } from "../helpers/utils.mjs";

test.describe("Queue public status page", () => {
  test("entering valid entry number shows team name", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    const entryInput = page.getByPlaceholder("번호");
    await entryInput.fill("1");
    await entryInput.dispatchEvent("input");

    // Entry 1 is "서울대학교 SNU Racing"
    await expect(page.locator(".team-badge").first()).toContainText("서울대학교");
  });

  test("entering invalid entry number shows error badge", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    const entryInput = page.getByPlaceholder("번호");
    await entryInput.fill("999");
    await entryInput.dispatchEvent("input");

    await expect(page.locator(".team-badge.error")).toContainText("존재하지 않는 엔트리");
  });

  test("querying with invalid entry shows error notification", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    const entryInput = page.getByPlaceholder("번호");
    await entryInput.fill("999");

    const phoneInput = page.getByPlaceholder("010-0000-0000");
    await phoneInput.fill("01012345678");

    await page.getByRole("button", { name: "조회" }).click();

    // Should show error notification
    await expect(page.locator(".notyf__toast--error").last()).toBeVisible({ timeout: 5000 });
  });

  test("querying without entry number shows error", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    await page.getByRole("button", { name: "조회" }).click();

    await expect(page.locator(".notyf__toast--error").last()).toContainText("엔트리 번호를 입력하세요", { timeout: 5000 });
  });

  test("querying with valid entry but no queue shows no-queue message", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    const entryInput = page.getByPlaceholder("번호");
    await entryInput.fill("1");

    const phoneInput = page.getByPlaceholder("010-0000-0000");
    await phoneInput.fill("01012345678");

    await page.getByRole("button", { name: "조회" }).click();

    // Should show error that phone doesn't match or no queue
    await expect(page.locator(".notyf__toast").last()).toBeVisible({ timeout: 5000 });
  });

  test("result section shows placeholder when no query made", async ({ page }) => {
    await page.goto("/queue");
    await waitForPageReady(page);

    await expect(page.getByRole("heading", { name: /실시간 대기 순번/ })).toBeVisible();
    // Default result display shows "-"
    await expect(page.locator(".result-display")).toContainText("-");
  });
});
