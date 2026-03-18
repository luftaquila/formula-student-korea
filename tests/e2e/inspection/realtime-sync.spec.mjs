import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Inspection real-time sync via SSE", () => {
  test("syncs passfail answer between two browser contexts", async ({ browser }) => {
    // Create two independent contexts with the same auth
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Both navigate to the same team's inspection sheet
    await page1.goto(`/inspection/${YEAR}/2`);
    await page2.goto(`/inspection/${YEAR}/2`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);

    // Wait for SSE connections to establish
    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

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

    await page1.goto(`/inspection/${YEAR}/3`);
    await page2.goto(`/inspection/${YEAR}/3`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);

    // Wait for SSE connections to establish
    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Set inspector name in context 1 (required for category result)
    const inspector1 = page1.locator(".inspector-input");
    await inspector1.fill("동기화검사");
    await inspector1.blur();
    await page1.waitForTimeout(500);

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
    await inspector1.fill("");
    await inspector1.blur();
    await page1.waitForTimeout(500);

    await context1.close();
    await context2.close();
  });

  test("syncs inspector name between two browser contexts", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    await page1.goto(`/inspection/${YEAR}/10`);
    await page2.goto(`/inspection/${YEAR}/10`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);

    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Enter inspector name in context 1 (blur triggers broadcast)
    const inspector1 = page1.locator(".inspector-input");
    await inspector1.fill("김검차");
    await inspector1.blur();

    // Verify the inspector name appears in context 2
    const inspector2 = page2.locator(".inspector-input");
    await expect(inspector2).toHaveValue("김검차", { timeout: 5000 });

    // Clean up
    await inspector1.fill("");
    await inspector1.blur();
    await page1.waitForTimeout(500);

    await context1.close();
    await context2.close();
  });

  test("syncs number answer between two browser contexts", async ({ browser }) => {
    const context1 = await browser.newContext({ storageState: storageStatePath("official") });
    const context2 = await browser.newContext({ storageState: storageStatePath("official") });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    await page1.goto(`/inspection/${YEAR}/20`);
    await page2.goto(`/inspection/${YEAR}/20`);

    await waitForPageReady(page1);
    await waitForPageReady(page2);

    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Find the "절연 저항 측정" number input in context 1
    const itemRow1 = page1.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const numInput1 = itemRow1.locator('input[type="number"]');

    // Enter a value
    await numInput1.fill("99");

    // Wait for debounce
    await page1.waitForTimeout(500);

    // Verify the value appears in context 2
    const itemRow2 = page2.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const numInput2 = itemRow2.locator('input[type="number"]');
    await expect(numInput2).toHaveValue("99", { timeout: 5000 });

    // Clean up
    await numInput1.fill("");
    await page1.waitForTimeout(500);

    await context1.close();
    await context2.close();
  });
});
