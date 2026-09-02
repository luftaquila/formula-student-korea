import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Inspection real-time sync via SSE", () => {
  // Dual-context SSE tests may need extra time on 2-core CI
  test.describe.configure({ timeout: 60000 });

  test("syncs passfail answer between two browser contexts", async ({ browser }) => {
    // Create two independent contexts with the same auth
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));

    // Both navigate to the same team's inspection sheet
    await page1.goto(`/inspection/${YEAR}/2`);
    await page2.goto(`/inspection/${YEAR}/2`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Find a passfail item ("전압 확인") in context 1
    const itemRow1 = page1.locator(".item-row").filter({ hasText: "전압 확인" });
    const passBtn1 = itemRow1.locator(".pf-toggle button").first();

    // Verify the item is not yet answered in context 2
    const itemRow2 = page2.locator(".item-row").filter({ hasText: "전압 확인" });
    const passBtn2 = itemRow2.locator(".pf-toggle button").first();
    await expect(passBtn2).not.toHaveClass(/btn-success/);

    // Click PASS in context 1
    await passBtn1.click();
    await expect(passBtn1).toHaveClass(/btn-success/);

    // Verify the change appears in context 2 via SSE
    await expect(passBtn2).toHaveClass(/btn-success/, { timeout: 5000 });

    // Clean up: toggle off in context 1
    await passBtn1.click();
    await expect(passBtn1).not.toHaveClass(/btn-success/);

    // Verify cleanup propagates to context 2
    await expect(passBtn2).not.toHaveClass(/btn-success/, { timeout: 5000 });

    await context1.close();
    await context2.close();
  });

  test("syncs category result between two browser contexts", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));

    await page1.goto(`/inspection/${YEAR}/3`);
    await page2.goto(`/inspection/${YEAR}/3`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Set category result to FAIL in context 1
    const failBtn1 = page1.locator(".result-toggle button").filter({ hasText: "FAIL" });
    await failBtn1.click();
    await expect(failBtn1).toHaveClass(/btn-danger/);

    // Verify the FAIL result badge appears in context 2's tab
    const activeTab2 = page2.locator(".tabs .tab.active");
    await expect(activeTab2.locator(".tab-badge")).toHaveText("FAIL", { timeout: 5000 });

    // Also verify the result toggle button in context 2 reflects the change
    const failBtn2 = page2.locator(".result-toggle button").filter({ hasText: "FAIL" });
    await expect(failBtn2).toHaveClass(/btn-danger/, { timeout: 5000 });

    // Clean up result
    await failBtn1.click();

    await context1.close();
    await context2.close();
  });

  test("syncs automatic inspectors and answer edit metadata via SSE", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    const adminPage = await adminContext.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    await page.goto(`/inspection/${YEAR}/10`);
    await waitForPageReady(page);
    await sse;

    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((candidate) => candidate.name === "전기 검차");
    const item = category.subcategories[0].groups[0].items.find((candidate) => candidate.name === "전압 확인");
    const row = page.locator(".item-row").filter({ hasText: item.name });
    const dataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/10`);
    const data = await dataRes.json();
    const currentValue = data.answers[item.id]?.value || "";
    const newValue = currentValue === "PASS" ? "FAIL" : "PASS";

    const putRes = await adminPage.request.put("/competition/api/v1/inspection/sheet/answer", {
      data: { year: YEAR, team_num: 10, item_id: item.id, value: newValue, expectedValue: currentValue },
    });
    expect(putRes.status()).toBe(200);

    await expect(page.locator(".inspector-list")).toContainText("E2E Admin", { timeout: 15000 });
    await expect(row.locator(".answer-edit-metadata")).toContainText("E2E Admin", { timeout: 15000 });
    await expect(row.locator(".answer-edit-metadata")).not.toContainText("응답 ·");

    await adminPage.request.put("/competition/api/v1/inspection/sheet/answer", {
      data: { year: YEAR, team_num: 10, item_id: item.id, value: "", expectedValue: newValue },
    });

    await adminContext.close();
    await context.close();
  });

  test("syncs number answer via API save to browser SSE", async ({ browser }) => {
    // Use single context + API save to avoid slow dual-context setup
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    await page.goto(`/inspection/${YEAR}/20`);
    await waitForPageReady(page);
    await sse;

    // Get template to find the item ID by name
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    const item = category.subcategories[0].groups[0].items.find((i) => i.name === "절연 저항 측정");

    // Ensure the item row is rendered before proceeding
    const numInput = page.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator('input[type="number"]');
    await expect(numInput).toBeVisible();

    // Read current DB value via API to pick a guaranteed-different value
    const dataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/20`);
    const data = await dataRes.json();
    const currentDbVal = data.answers[item.id]?.value || "";
    const newValue = currentDbVal === "42" ? "88" : "42";

    // Save via API (triggers SSE broadcast since value differs from DB)
    const putRes = await page.request.put("/competition/api/v1/inspection/sheet/answer", {
      data: { year: YEAR, team_num: 20, item_id: item.id, value: newValue, expectedValue: currentDbVal },
    });
    expect(putRes.status()).toBe(200);

    await expect(numInput).toHaveValue(newValue, { timeout: 15000 });

    // Clean up
    await page.request.put("/competition/api/v1/inspection/sheet/answer", {
      data: { year: YEAR, team_num: 20, item_id: item.id, value: "", expectedValue: newValue },
    });

    await context.close();
  });

  test("syncs memo via API save to browser SSE", async ({ browser }) => {
    // Use single context + API save to avoid slow dual-context setup
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    await page.goto(`/inspection/${YEAR}/2`);
    await waitForPageReady(page);
    await sse;

    // Get template to find the item ID by name
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    const item = category.subcategories[0].groups[0].items.find((i) => i.name === "전압 확인");

    const memoText = page.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".memo-text");
    await expect(memoText).toBeVisible();

    // Read current DB value via API to pick a guaranteed-different value
    const dataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/2`);
    const data = await dataRes.json();
    const currentDbMemo = data.answers[item.id]?.memo || "";
    const newMemo = currentDbMemo === "SSE메모" ? "동기화확인" : "SSE메모";

    // Save a new memo via API (guaranteed to be different from DB)
    const putRes = await page.request.put("/competition/api/v1/inspection/sheet/memo", {
      data: { year: YEAR, team_num: 2, item_id: item.id, memo: newMemo, expectedMemo: currentDbMemo },
    });
    expect(putRes.status()).toBe(200);

    await expect(memoText).toContainText(newMemo, { timeout: 15000 });

    // Clean up
    await page.request.put("/competition/api/v1/inspection/sheet/memo", {
      data: { year: YEAR, team_num: 2, item_id: item.id, memo: "", expectedMemo: newMemo },
    });

    await context.close();
  });

  test("discards a focused stale edit and requires refresh", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/events"));

    // Use team #2 (한양대학교)
    await page1.goto(`/inspection/${YEAR}/2`);
    await page2.goto(`/inspection/${YEAR}/2`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Find a number input item ("절연 저항 측정") in both contexts
    const itemRow1 = page1.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const numInput1 = itemRow1.locator('input[type="number"]');
    const itemRow2 = page2.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const numInput2 = itemRow2.locator('input[type="number"]');

    // Pick a value different from current to guarantee save fires
    const currentVal = await numInput1.inputValue();
    const deferredValue = currentVal === "77" ? "55" : "77";

    // Context 2: focus on the number input (triggers focusedItemId) but do NOT edit
    // Just clicking focuses the input and sets focusedItemId without adding to editedDuringFocus
    await numInput2.click();
    await expect(numInput2).toBeFocused();

    // Context 1: enter a value and save via the debounced answer handler
    const answerSavePromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await numInput1.fill(deferredValue);
    await answerSavePromise;

    // A remote write wins immediately. The focused browser discards its stale
    // local state and tells the operator to refresh before trying again.
    await expect(numInput2).toHaveValue(deferredValue, { timeout: 5000 });
    await expectNotification(page2, "error", "새로고침 후 다시 작성하세요");

    // Cleanup: clear value
    const cleanupPromise = page1.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await numInput1.fill("");
    await cleanupPromise;

    await context1.close();
    await context2.close();
  });
});
