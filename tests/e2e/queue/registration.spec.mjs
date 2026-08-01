import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

test.describe("Queue registration", () => {
  test.use({ storageState: storageStatePath("chief") });

  test("loads /queue/register page with inspection type buttons", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // Should show inspection type selection
    await expect(page.getByText("검차 종류 선택")).toBeVisible();
    // Should show entry and phone input fields
    await expect(page.locator("label", { hasText: "엔트리" })).toBeVisible();
    await expect(page.locator("label", { hasText: "전화번호" })).toBeVisible();
    // Should show agreement and submit buttons
    await expect(page.getByText("개인정보 수집 및 이용에 동의합니다")).toBeVisible();
    await expect(page.getByRole("button", { name: "등록하기" })).toBeVisible();
    await expect(page.getByRole("button", { name: "초기화" })).toBeVisible();
  });

  test("shows queue status QR code with a data-URL image", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    const qrImage = page.locator(".qr-card .qr-image");
    await expect(qrImage).toBeVisible({ timeout: 10000 });
    await expect(qrImage).toHaveAttribute("src", /^data:image\//);
    await expect(page.getByText("내 순번 조회")).toBeVisible();
  });

  test("shows active inspection type buttons", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // At least some inspection types should be visible as buttons
    const inspectionButtons = page.locator(".inspection-btn");
    await expect(inspectionButtons.first()).toBeVisible({ timeout: 10000 });
    const count = await inspectionButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test("selecting inspection type highlights the button", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    const firstButton = page.locator(".inspection-btn").first();
    await expect(firstButton).toBeVisible({ timeout: 10000 });
    await firstButton.click();

    await expect(firstButton).toHaveClass(/selected/);
  });

  test("entering valid entry number shows team name", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    const entryInput = page.locator(".entry-input");
    await entryInput.fill("1");

    await expect(page.locator(".team-badge").first()).toContainText("서울대학교");
  });

  test("entering invalid entry number shows error badge", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    const entryInput = page.locator(".entry-input");
    await entryInput.fill("999");

    await expect(page.locator(".team-badge.error")).toContainText("존재하지 않는 엔트리");
  });

  test("submitting without selecting inspection shows error", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    const entryInput = page.locator(".entry-input");
    await entryInput.fill("1");

    const phoneInput = page.locator('input[type="tel"]');
    await phoneInput.fill("01012345678");

    // Agree to terms
    await page.getByText("개인정보 수집 및 이용에 동의합니다").click();

    await page.getByRole("button", { name: "등록하기" }).click();

    await expectNotification(page, "error", "검차 종류를 선택하세요");
  });

  test("submitting without agreement shows error", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // Select inspection type
    const firstButton = page.locator(".inspection-btn").first();
    await expect(firstButton).toBeVisible({ timeout: 10000 });
    await firstButton.click();

    const entryInput = page.locator(".entry-input");
    await entryInput.fill("1");

    const phoneInput = page.locator('input[type="tel"]');
    await phoneInput.fill("01012345678");

    // Do NOT agree to terms
    await page.getByRole("button", { name: "등록하기" }).click();

    await expectNotification(page, "error", "개인정보 수집 및 이용에 동의해주세요");
  });

  test("successfully register an entry to inspection queue", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // Select first active inspection type
    const firstButton = page.locator(".inspection-btn").first();
    await expect(firstButton).toBeVisible({ timeout: 10000 });
    await firstButton.click();

    // Enter entry number
    const entryInput = page.locator(".entry-input");
    await entryInput.fill("10");

    // Enter phone number
    const phoneInput = page.locator('input[type="tel"]');
    await phoneInput.fill("01098765432");

    // Agree to terms
    await page.getByText("개인정보 수집 및 이용에 동의합니다").click();

    // Submit
    await page.getByRole("button", { name: "등록하기" }).click();

    // Should show success notification
    await expectNotification(page, "success", "등록되었습니다");
  });

  test("reset button clears the form", async ({ page }) => {
    await page.goto("/queue/register");
    await waitForPageReady(page);

    // Fill in some data
    const entryInput = page.locator(".entry-input");
    await entryInput.fill("1");

    // Click reset
    await page.getByRole("button", { name: "초기화" }).click();

    // Entry input should be cleared
    await expect(entryInput).toHaveValue("");
  });
});
