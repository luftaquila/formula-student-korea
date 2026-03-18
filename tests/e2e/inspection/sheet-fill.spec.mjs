import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Inspection sheet filling", () => {
  test.use({ storageState: storageStatePath("official") });

  test.beforeEach(async ({ page }) => {
    // Navigate to inspection sheet for team 1
    await page.goto(`/inspection/${YEAR}/1`);
    await waitForPageReady(page);
  });

  test("renders team header and template categories", async ({ page }) => {
    // Verify team header
    const teamHeader = page.locator(".team-header");
    await expect(teamHeader).toContainText("#1");
    await expect(teamHeader).toContainText("서울대학교");
    await expect(teamHeader).toContainText("SNU Racing");

    // Verify category tabs
    const tabs = page.locator(".tabs .tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toContainText("전기 검차");
    await expect(tabs.nth(1)).toContainText("샤시 검차");

    // Verify items are rendered
    const panel = page.locator(".category-panel");
    await expect(panel).toContainText("절연 저항 측정");
    await expect(panel).toContainText("전압 확인");
    await expect(panel).toContainText("고정 상태");
  });

  test("clicks PASS on a passfail item", async ({ page }) => {
    // Find the "전압 확인" item row (passfail type)
    const itemRow = page.locator(".item-row").filter({ hasText: "전압 확인" });
    await expect(itemRow).toBeVisible();

    // Click the PASS button (labeled "P")
    const passBtn = itemRow.locator(".pf-toggle button").first();
    await expect(passBtn).toContainText("P");
    await passBtn.click();

    // Verify the PASS button becomes active (btn-success class)
    await expect(passBtn).toHaveClass(/btn-success/);

    // Click again to toggle off
    await passBtn.click();
    await expect(passBtn).not.toHaveClass(/btn-success/);
  });

  test("clicks FAIL on a passfail item", async ({ page }) => {
    // Find the "고정 상태" item row (passfail type)
    const itemRow = page.locator(".item-row").filter({ hasText: "고정 상태" });
    await expect(itemRow).toBeVisible();

    // Click the FAIL button (labeled "F")
    const failBtn = itemRow.locator(".pf-toggle button").nth(1);
    await expect(failBtn).toContainText("F");
    await failBtn.click();

    // Verify the FAIL button becomes active (btn-danger class)
    await expect(failBtn).toHaveClass(/btn-danger/);

    // Clean up: toggle off
    await failBtn.click();
    await expect(failBtn).not.toHaveClass(/btn-danger/);
  });

  test("enters a number for a number-type item", async ({ page }) => {
    // Find the "절연 저항 측정" item row (number type)
    const itemRow = page.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    await expect(itemRow).toBeVisible();

    // Verify unit label is shown
    await expect(itemRow.locator(".unit-label")).toHaveText("MΩ");

    // Enter a number value
    const numberInput = itemRow.locator('input[type="number"]');
    await numberInput.fill("42");

    // Wait for debounced save to complete
    await page.waitForTimeout(500);

    // Verify the value persists by reloading
    await page.reload();
    await waitForPageReady(page);

    const reloadedRow = page.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    const reloadedInput = reloadedRow.locator('input[type="number"]');
    await expect(reloadedInput).toHaveValue("42");

    // Clean up: clear the value
    await reloadedInput.fill("");
    await page.waitForTimeout(500);
  });

  test("enters inspector name", async ({ page }) => {
    // Find the inspector input in the panel header
    const inspectorInput = page.locator(".inspector-input");
    await expect(inspectorInput).toBeVisible();

    // Enter inspector name
    await inspectorInput.fill("홍길동");
    await inspectorInput.blur();

    // Wait for save
    await page.waitForTimeout(500);

    // Verify the value persists by reloading
    await page.reload();
    await waitForPageReady(page);

    await expect(page.locator(".inspector-input")).toHaveValue("홍길동");

    // Clean up
    await page.locator(".inspector-input").fill("");
    await page.locator(".inspector-input").blur();
    await page.waitForTimeout(500);
  });

  test("sets category result to PASS", async ({ page }) => {
    // First enter an inspector name (required for setting category result)
    const inspectorInput = page.locator(".inspector-input");
    await inspectorInput.fill("테스트관");
    await inspectorInput.blur();
    await page.waitForTimeout(500);

    // Click the PASS button in the result toggle
    const resultPassBtn = page.locator(".result-toggle button").filter({ hasText: "PASS" });
    await resultPassBtn.click();

    // Verify the button becomes active
    await expect(resultPassBtn).toHaveClass(/btn-success/);

    // Verify the tab badge shows PASS
    const activeTab = page.locator(".tabs .tab.active");
    await expect(activeTab.locator(".tab-badge")).toHaveText("PASS");

    // Clean up: toggle off the result
    await resultPassBtn.click();
    await expect(resultPassBtn).not.toHaveClass(/btn-success/);

    // Clean up inspector name
    await inspectorInput.fill("");
    await inspectorInput.blur();
    await page.waitForTimeout(500);
  });

  test("sets category result to FAIL", async ({ page }) => {
    // Enter inspector name first
    const inspectorInput = page.locator(".inspector-input");
    await inspectorInput.fill("테스트관");
    await inspectorInput.blur();
    await page.waitForTimeout(500);

    // Click the FAIL button
    const resultFailBtn = page.locator(".result-toggle button").filter({ hasText: "FAIL" });
    await resultFailBtn.click();

    // Verify the button becomes active
    await expect(resultFailBtn).toHaveClass(/btn-danger/);

    // Verify the tab badge shows FAIL
    const activeTab = page.locator(".tabs .tab.active");
    await expect(activeTab.locator(".tab-badge")).toHaveText("FAIL");

    // Clean up
    await resultFailBtn.click();
    await inspectorInput.fill("");
    await inspectorInput.blur();
    await page.waitForTimeout(500);
  });

  test("enters memo for an item via click-to-edit", async ({ page }) => {
    // Find the first item row with a memo area
    const itemRow = page.locator(".item-row").first();
    await expect(itemRow).toBeVisible();

    // Click the memo text span to start editing (click-to-edit pattern)
    const memoText = itemRow.locator(".memo-text");
    await expect(memoText).toBeVisible();
    await memoText.click();

    // The memo input should now be visible
    const memoInput = itemRow.locator(".memo-input");
    await expect(memoInput).toBeVisible();

    // Type a memo
    await memoInput.fill("테스트 메모 입력");
    await memoInput.blur();

    // Wait for debounced save
    await page.waitForTimeout(500);

    // Reload and verify the memo persists
    await page.reload();
    await waitForPageReady(page);

    const reloadedRow = page.locator(".item-row").first();
    const reloadedMemo = reloadedRow.locator(".memo-text");
    await expect(reloadedMemo).toHaveText("테스트 메모 입력");

    // Clean up: clear the memo
    await reloadedMemo.click();
    const clearInput = reloadedRow.locator(".memo-input");
    await clearInput.fill("");
    await clearInput.blur();
    await page.waitForTimeout(500);
  });

  test("requires inspector name before setting category result", async ({ page }) => {
    // Ensure inspector name is empty
    const inspectorInput = page.locator(".inspector-input");
    await inspectorInput.fill("");
    await inspectorInput.blur();
    await page.waitForTimeout(300);

    // Try to set PASS without inspector name
    const resultPassBtn = page.locator(".result-toggle button").filter({ hasText: "PASS" });
    await resultPassBtn.click();

    // Should show error notification
    const errorToast = page.locator(".notyf__toast--error");
    await expect(errorToast.last()).toContainText("검차관 이름을 입력하세요", { timeout: 5000 });

    // PASS button should not be active
    await expect(resultPassBtn).not.toHaveClass(/btn-success/);
  });
});
