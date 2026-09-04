import { test, expect } from "@playwright/test";
import {
  expectNotification,
  expectNotificationAfter,
  storageStatePath,
  waitForPageReady,
} from "../helpers/utils.mjs";

const TYPE = "rain";
const TYPE_NAME = "우천";
const ENTRY_NUM = 10;
const PHONE = "01098765432";

async function clearOwnedRegistration(request) {
  const enter = await request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
    data: { num: ENTRY_NUM },
  });
  expect([200, 400]).toContain(enter.status());
  if (enter.status() === 200) {
    const exit = await request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    expect(exit.status()).toBe(200);
  }

  const penalty = await request.delete(`/competition/api/v1/queue/admin/penalties/${TYPE}/${ENTRY_NUM}`);
  expect([200, 404]).toContain(penalty.status());
}

test.describe("Queue registration", () => {
  test.use({ storageState: storageStatePath("operationsManager") });

  test.beforeEach(async ({ page }) => {
    await clearOwnedRegistration(page.request);
    await page.goto("/queue/register");
    await waitForPageReady(page);
  });

  test.afterEach(async ({ page }) => {
    await clearOwnedRegistration(page.request);
  });

  test("renders the complete form and keeps selection, entry feedback, QR, and reset in sync", async ({ page }) => {
    await expect(page.getByText("검차 종류 선택")).toBeVisible();
    await expect(page.locator("label", { hasText: "엔트리" })).toBeVisible();
    await expect(page.locator("label", { hasText: "전화번호" })).toBeVisible();
    await expect(page.getByText("개인정보 수집 및 이용에 동의합니다")).toBeVisible();
    await expect(page.getByRole("button", { name: "등록하기" })).toBeVisible();

    const qrImage = page.locator(".qr-card .qr-image");
    await expect(qrImage).toBeVisible({ timeout: 10000 });
    await expect(qrImage).toHaveAttribute("src", /^data:image\//);
    await expect(page.getByText("내 순번 조회")).toBeVisible();

    const inspectionButtons = page.locator(".inspection-btn");
    expect(await inspectionButtons.count()).toBeGreaterThan(0);
    const rainButton = inspectionButtons.filter({ hasText: TYPE_NAME });
    await expect(rainButton).toBeVisible();
    await rainButton.click();
    await expect(rainButton).toHaveClass(/selected/);

    const entryInput = page.locator(".entry-input");
    await entryInput.fill("1");
    await expect(page.locator(".team-badge").first()).toContainText("서울대학교");
    await entryInput.fill("999");
    await expect(page.locator(".team-badge.error")).toContainText("존재하지 않는 엔트리");

    await page.locator('input[type="tel"]').fill(PHONE);
    await page.getByText("개인정보 수집 및 이용에 동의합니다").click();
    await page.getByRole("button", { name: "초기화" }).click();
    await expectNotification(page, "warning", "입력이 초기화되었습니다");
    await expect(entryInput).toHaveValue("");
    await expect(page.locator('input[type="tel"]')).toHaveValue("010");
    await expect(page.locator(".inspection-btn.selected")).toHaveCount(0);
    await expect(page.locator(".agreement-btn")).not.toHaveClass(/agreed/);
  });

  test("reports each missing registration requirement at the point of submission", async ({ page }) => {
    await page.locator(".entry-input").fill(String(ENTRY_NUM));
    await page.locator('input[type="tel"]').fill(PHONE);
    const agreement = page.getByText("개인정보 수집 및 이용에 동의합니다");
    await agreement.click();

    await page.getByRole("button", { name: "등록하기" }).click();
    await expectNotification(page, "error", "검차 종류를 선택하세요");

    await page.locator(".inspection-btn").filter({ hasText: TYPE_NAME }).click();
    await agreement.click();
    await expectNotificationAfter(
      page,
      "error",
      "개인정보 수집 및 이용에 동의해주세요",
      () => page.getByRole("button", { name: "등록하기" }).click(),
    );
  });

  test("registers an owned team through the UI and resets the completed form", async ({ page }) => {
    await page.locator(".inspection-btn").filter({ hasText: TYPE_NAME }).click();
    await page.locator(".entry-input").fill(String(ENTRY_NUM));
    await expect(page.locator(".team-badge").first()).toContainText("KAIST");
    await page.locator('input[type="tel"]').fill(PHONE);
    await page.getByText("개인정보 수집 및 이용에 동의합니다").click();

    const registered = page.waitForResponse(
      (response) =>
        response.url().includes(`/competition/api/v1/queue/admin/register/${TYPE}`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "등록하기" }).click();
    expect((await registered).status()).toBe(201);

    await expectNotification(page, "success", `${ENTRY_NUM}번 엔트리가 등록되었습니다`);
    await expect(page.locator(".entry-input")).toHaveValue("");
    await expect(page.locator('input[type="tel"]')).toHaveValue("010");
    await expect(page.locator(".inspection-btn.selected")).toHaveCount(0);
  });
});
