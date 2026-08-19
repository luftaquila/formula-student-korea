import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = currentCompetitionYear();

test.describe("Three concurrent inspection editors", () => {
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Get template to find item IDs by name
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    const items = category.subcategories[0].groups[0].items;
    const passfailItem = items.find((i) => i.name === "전압 확인");
    const numberItem = items.find((i) => i.name === "절연 저항 측정");

    const dataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/30`);
    const sheetData = await dataRes.json();

    // Clear answers for team 30 via API
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };
    if (passfailItem) {
      await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/answer`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: 30,
          item_id: passfailItem.id,
          value: "",
          expectedValue: sheetData.answers[passfailItem.id]?.value || "",
        }),
      });
    }
    if (numberItem) {
      await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/answer`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: 30,
          item_id: numberItem.id,
          value: "",
          expectedValue: sheetData.answers[numberItem.id]?.value || "",
        }),
      });
    }

    // Clear memo for passfail item
    if (passfailItem) {
      await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/memo`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: 30,
          item_id: passfailItem.id,
          memo: "",
          expectedMemo: sheetData.answers[passfailItem.id]?.memo || "",
        }),
      });
    }

    // Clear inspector
    await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/inspector`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ year: YEAR, team_num: 30, category_id: category.id, inspector: "" }),
    });

    await context.close();
  });

  test("edits from 3 editors propagate to all via SSE", async ({ browser }) => {
    // Create 3 independent contexts
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });
    const context3 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    const page3 = await context3.newPage();

    // SSE setup before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    const sse3 = page3.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));

    // All navigate to team 30's inspection sheet
    await page1.goto(`/inspection/${YEAR}/30`);
    await page2.goto(`/inspection/${YEAR}/30`);
    await page3.goto(`/inspection/${YEAR}/30`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await waitForPageReady(page3);
    await sse1;
    await sse2;
    await sse3;

    // Context 1: click PASS on "전압 확인"
    const itemRow1 = page1.locator(".item-row").filter({ hasText: "전압 확인" });
    const passBtn1 = itemRow1.locator(".pf-toggle button").first();
    await passBtn1.click();
    await expect(passBtn1).toHaveClass(/btn-success/);

    // Context 2 and 3 should see the PASS
    const passBtn2 = page2.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".pf-toggle button").first();
    const passBtn3 = page3.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".pf-toggle button").first();
    await expect(passBtn2).toHaveClass(/btn-success/, { timeout: 5000 });
    await expect(passBtn3).toHaveClass(/btn-success/, { timeout: 5000 });

    // Context 2: fill number input on "절연 저항 측정"
    const numRow2 = page2.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const numInput2 = numRow2.locator('input[type="number"]');
    const answerSave = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await numInput2.fill("42");
    await answerSave;

    // Context 1 and 3 should see "42"
    const numInput1 = page1.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator('input[type="number"]');
    const numInput3 = page3.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator('input[type="number"]');
    await expect(numInput1).toHaveValue("42", { timeout: 5000 });
    await expect(numInput3).toHaveValue("42", { timeout: 5000 });

    // Context 3: fill memo on "전압 확인"
    const memoRow3 = page3.locator(".item-row").filter({ hasText: "전압 확인" });
    const memoText3 = memoRow3.locator(".memo-text");
    await memoText3.click();
    const memoInput3 = memoRow3.locator(".memo-input");
    await expect(memoInput3).toBeVisible();
    const memoSave = page3.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/memo") && res.status() === 200);
    await memoInput3.fill("3명 동시 편집 테스트");
    await memoInput3.blur();
    await memoSave;

    // Context 1 and 2 should see the memo
    await expect(page1.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".memo-text")).toContainText("3명 동시 편집 테스트", { timeout: 5000 });
    await expect(page2.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".memo-text")).toContainText("3명 동시 편집 테스트", { timeout: 5000 });

    await context1.close();
    await context2.close();
    await context3.close();
  });
});
