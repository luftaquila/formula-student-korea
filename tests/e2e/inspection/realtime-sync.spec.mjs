import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

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
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/sheet/events"));

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
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/sheet/events"));

    await page1.goto(`/inspection/${YEAR}/3`);
    await page2.goto(`/inspection/${YEAR}/3`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);
    await sse1;
    await sse2;

    // Set inspector name in context 1 (required for category result)
    const inspector1 = page1.locator(".inspector-input");
    const currentInspector = await inspector1.inputValue();
    const newInspector = currentInspector === "동기화검사" ? "검차동기" : "동기화검사";
    const inspectorSavePromise = page1.waitForResponse((res) => res.url().includes("/api/sheet/inspector") && res.status() === 200);
    await inspector1.fill(newInspector);
    await inspector1.blur();
    await inspectorSavePromise;

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

    // Clean up: remove result and inspector
    await failBtn1.click();
    const cleanupPromise = page1.waitForResponse((res) => res.url().includes("/api/sheet/inspector") && res.status() === 200);
    await inspector1.fill("");
    await inspector1.blur();
    await Promise.race([cleanupPromise, page1.waitForTimeout(1000)]);

    await context1.close();
    await context2.close();
  });

  test("syncs inspector name via API save to browser SSE", async ({ browser }) => {
    // Use single context + API save to avoid slow dual-context setup
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    await page.goto(`/inspection/${YEAR}/10`);
    await waitForPageReady(page);
    await sse;

    // Get category ID for API call
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const categoryId = template[0].id;

    const inspectorInput = page.locator(".inspector-input");
    await expect(inspectorInput).toBeVisible();

    // Read current DB value to pick a different one
    const dataRes = await page.request.get(`/inspection/api/sheet/data/${YEAR}/10`);
    const data = await dataRes.json();
    const currentInspector = data.inspectors[categoryId] || "";
    const newInspector = currentInspector === "김검차" ? "이검사" : "김검차";

    // Save via API (triggers SSE broadcast)
    await page.request.put("/inspection/api/sheet/inspector", {
      data: { year: YEAR, team_num: 10, category_id: categoryId, inspector: newInspector },
    });

    // Verify SSE update
    await expect(inspectorInput).toHaveValue(newInspector, { timeout: 15000 });

    // Clean up
    await page.request.put("/inspection/api/sheet/inspector", {
      data: { year: YEAR, team_num: 10, category_id: categoryId, inspector: "" },
    });

    await context.close();
  });

  test("syncs number answer via API save to browser SSE", async ({ browser }) => {
    // Use single context + API save to avoid slow dual-context setup
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    await page.goto(`/inspection/${YEAR}/20`);
    await waitForPageReady(page);
    await sse;

    // Get template to find the item ID by name
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    const item = category.subcategories[0].groups[0].items.find((i) => i.name === "절연 저항 측정");

    // Ensure the item row is rendered before proceeding
    const numInput = page.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator('input[type="number"]');
    await expect(numInput).toBeVisible();

    // Read current DB value via API to pick a guaranteed-different value
    const dataRes = await page.request.get(`/inspection/api/sheet/data/${YEAR}/20`);
    const data = await dataRes.json();
    const currentDbVal = data.answers[item.id]?.value || "";
    const newValue = currentDbVal === "42" ? "88" : "42";

    // Save via API (triggers SSE broadcast since value differs from DB)
    const putRes = await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 20, item_id: item.id, value: newValue },
    });
    expect(putRes.status()).toBe(200);

    await expect(numInput).toHaveValue(newValue, { timeout: 15000 });

    // Clean up
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 20, item_id: item.id, value: "" },
    });

    await context.close();
  });

  test("syncs memo via API save to browser SSE", async ({ browser }) => {
    // Use single context + API save to avoid slow dual-context setup
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const sse = page.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    await page.goto(`/inspection/${YEAR}/2`);
    await waitForPageReady(page);
    await sse;

    // Get template to find the item ID by name
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    const item = category.subcategories[0].groups[0].items.find((i) => i.name === "전압 확인");

    const memoText = page.locator(".item-row").filter({ hasText: "전압 확인" }).locator(".memo-text");
    await expect(memoText).toBeVisible();

    // Read current DB value via API to pick a guaranteed-different value
    const dataRes = await page.request.get(`/inspection/api/sheet/data/${YEAR}/2`);
    const data = await dataRes.json();
    const currentDbMemo = data.answers[item.id]?.memo || "";
    const newMemo = currentDbMemo === "SSE메모" ? "동기화확인" : "SSE메모";

    // Save a new memo via API (guaranteed to be different from DB)
    const putRes = await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: 2, item_id: item.id, memo: newMemo },
    });
    expect(putRes.status()).toBe(200);

    await expect(memoText).toContainText(newMemo, { timeout: 15000 });

    // Clean up
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: 2, item_id: item.id, memo: "" },
    });

    await context.close();
  });

  test("deferred update when editing same answer concurrently", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up SSE listeners before navigation
    const sse1 = page1.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    const sse2 = page2.waitForResponse((res) => res.url().includes("/api/sheet/events"));

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
    const answerSavePromise = page1.waitForResponse((res) => res.url().includes("/api/sheet/answer") && res.status() === 200);
    await numInput1.fill(deferredValue);
    await answerSavePromise;

    // Wait for SSE to arrive in context 2
    await page2.waitForTimeout(2000);

    // Context 2's focused input should still show previous value (deferred, not applied yet)
    const ctx2Val = await numInput2.inputValue();
    expect(ctx2Val).not.toBe(deferredValue);

    // Context 2: blur to apply deferred update
    await numInput2.blur();

    // After blur, the deferred SSE value should apply since user didn't edit
    await expect(numInput2).toHaveValue(deferredValue, { timeout: 5000 });

    // Cleanup: clear value
    const cleanupPromise = page1.waitForResponse((res) => res.url().includes("/api/sheet/answer") && res.status() === 200);
    await numInput1.fill("");
    await Promise.race([cleanupPromise, page1.waitForTimeout(1000)]);

    await context1.close();
    await context2.close();
  });
});
