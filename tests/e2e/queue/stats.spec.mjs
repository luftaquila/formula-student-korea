import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const TYPE = "rain";
const ENTRY_NUM = 20;
const PHONE = "01020202020";

async function clearOwnedRegistration(request) {
  const cancelled = await request.post(`/queue/api/admin/cancel/${TYPE}`, {
    data: { num: ENTRY_NUM },
  });
  expect([200, 400]).toContain(cancelled.status());

  const penalty = await request.delete(`/queue/api/admin/penalties/${TYPE}/${ENTRY_NUM}`);
  expect([200, 404]).toContain(penalty.status());
}

test.describe("Queue statistics page", () => {
  test.use({ storageState: storageStatePath("official") });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("chief") });
    await clearOwnedRegistration(context.request);
    const registered = await context.request.post(`/queue/api/admin/register/${TYPE}`, {
      data: { num: ENTRY_NUM, phone: PHONE },
    });
    expect(registered.status()).toBe(201);
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("chief") });
    await clearOwnedRegistration(context.request);
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/queue/stats");
    await waitForPageReady(page);
  });

  test("renders the full filter and statistics table contract", async ({ page }) => {
    await expect(page.getByRole("button", { name: "돌아가기" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /팀별 통계/ })).toBeVisible();

    const yearSelect = page.locator(".filter-group", { hasText: "엔트리" }).locator("select");
    await expect(yearSelect).toBeVisible();

    const dateInputs = page.locator('input[type="date"]');
    await expect(dateInputs).toHaveCount(2);
    await expect(dateInputs.first()).toBeVisible();

    const inspectionSelect = page.locator(".filter-group", { hasText: "검차 종류" }).locator("select");
    await expect(inspectionSelect).toBeVisible();
    await expect(inspectionSelect.locator("option").first()).toHaveText("전체");
    expect(await inspectionSelect.locator("option").count()).toBeGreaterThan(1);

    const table = page.locator(".stats-table");
    await expect(table).toBeVisible({ timeout: 10000 });
    await expect(table.getByRole("columnheader")).toHaveText([
      /번호/,
      /팀/,
      /등록/,
      /취소/,
      /입장/,
      /검차 시간/,
    ]);
  });

  test("persists the date range and filters to the owned inspection data", async ({ page }) => {
    const fromInput = page.locator('input[type="date"]').first();
    const newFrom = "2000-01-01";
    await fromInput.fill(newFrom);
    await fromInput.dispatchEvent("change");

    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("queue-stats-daterange")))
      .toContain(newFrom);

    await page.reload();
    await waitForPageReady(page);
    await expect(page.locator('input[type="date"]').first()).toHaveValue(newFrom);

    const inspectionSelect = page.locator(".filter-group", { hasText: "검차 종류" }).locator("select");
    const filtered = page.waitForResponse(
      (response) => response.url().includes("/queue/api/admin/stats") && response.status() === 200,
    );
    await inspectionSelect.selectOption(TYPE);
    await filtered;

    const ownedRow = page.locator(".stats-table tbody .clickable-row").filter({ hasText: "고려대학교" });
    await expect(ownedRow).toBeVisible();
    await expect(ownedRow.locator(".entry-num")).toHaveText(String(ENTRY_NUM));
  });

  test("sorts rows, expands the owned timeline, and returns to administration", async ({ page }) => {
    const numHeader = page.locator("th.sortable", { hasText: "번호" });
    await numHeader.click();
    await expect(numHeader).toContainText(/▲|▼/);
    const firstDirection = await numHeader.textContent();
    await numHeader.click();
    await expect(numHeader).toContainText(/▲|▼/);
    expect(await numHeader.textContent()).not.toBe(firstDirection);

    const ownedRow = page.locator(".stats-table tbody .clickable-row").filter({ hasText: "고려대학교" });
    await expect(ownedRow).toBeVisible();
    await ownedRow.click();

    const timeline = page.locator(".timeline-section");
    await expect(timeline).toBeVisible();
    await expect(timeline.getByRole("heading", { name: /#20.*고려대학교.*타임라인/ })).toBeVisible();
    await expect(timeline.locator(".timeline-table tbody")).toContainText("우천");

    await timeline.getByRole("button", { name: "닫기" }).click();
    await expect(timeline).not.toBeVisible();

    await page.getByRole("button", { name: "돌아가기" }).click();
    await expect(page).toHaveURL(/\/queue\/admin/);
  });
});
