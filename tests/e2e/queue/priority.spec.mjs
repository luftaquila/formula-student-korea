import { test, expect } from "@playwright/test";
import { expectCompactTeamIdentity, storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "battery";

async function apiResetPriorities(type = INSPECTION_TYPE) {
  await fetch(`${BASE_URL}/competition/api/v1/queue/admin/priority/${type}/all`, {
    method: "DELETE",
    headers: { Cookie: getAuthCookie("operationsManager") },
  });
}

test.describe("Queue priority management", () => {
  test.use({ storageState: storageStatePath("operationsManager") });

  test.beforeEach(async () => {
    await apiResetPriorities();
  });

  test.afterEach(async () => {
    await apiResetPriorities();
  });

  test("loads /queue/priority page with team table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Should show the priority rules section
    await expect(page.getByText("우선순위 규칙")).toBeVisible();

    // Should show team priority table
    await expect(page.getByRole("heading", { name: /우선순위 설정/ })).toBeVisible();

    // Should show back button
    await expect(page.getByRole("button", { name: "돌아가기" })).toBeVisible();
  });

  test("shows entries in priority table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Wait for the table to load
    const table = page.locator(".priority-table:not([data-table-head-copy])");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Should show entry numbers from seeded data (use exact match to avoid "1" matching "10")
    await expect(page.locator(".priority-table .entry-num").filter({ hasText: /^1$/ })).toBeVisible();
    await expect(page.locator(".priority-table .entry-num").filter({ hasText: /^2$/ })).toBeVisible();
    await expect(page.locator(".priority-table .entry-num").filter({ hasText: /^3$/ })).toBeVisible();
  });

  test("uses the compact mobile identity column and persistent type filter", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    const table = page.locator(".priority-table:not([data-table-head-copy])");
    const row = table.locator("tbody tr").first();
    await expect(table.locator("thead .col-num")).toContainText("엔트리");
    await expect(page.getByTestId("queue-priority-sticky-header").locator("th").first()).toContainText("엔트리");
    await expect(page.locator(".sticky-freeze-line")).toHaveCount(0);
    await expect(row.locator(".team-mobile-entry-univ")).toBeVisible();
    await expect(row.locator(".team-mobile-entry-name")).toBeVisible();
    await expect(row.locator(".team-mobile-entry-type")).toBeVisible();
    await expect(row.locator("td.col-team")).toBeHidden();
    await expect(row.locator("td.col-type")).toBeHidden();
    await expectCompactTeamIdentity(table);

    const cv = page.getByTestId("queue-priority-type-filter").locator("label", { hasText: "CV" }).locator("input");
    await cv.uncheck();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("queue-priority-type-filter"))).toContain('"CV":false');
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("queue-priority-type-filter").locator("label", { hasText: "CV" }).locator("input")).not.toBeChecked();
  });

  test("set team priority via input", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Wait for table to load
    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    // Find the first priority input in the row for entry 1
    const row = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^1$/ }) });
    const priorityInput = row.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`);
    await expect(priorityInput).toBeVisible();

    // Set priority to 1
    await priorityInput.fill("1");
    await priorityInput.dispatchEvent("change");

    // Should show success notification
    await expectNotification(page, "success", "우선순위");
  });

  test("remove team priority by clearing input", async ({ page }) => {
    // First set a priority via API
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/priority/${INSPECTION_TYPE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ num: 2, priority: 1 }),
    });

    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    // Find the priority input for entry 2 in the battery column
    const row = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^2$/ }) });
    const priorityInput = row.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`);
    await expect(priorityInput).toBeVisible();

    // The input should show current priority
    await expect(priorityInput).toHaveValue("1");

    // Clear the input to remove priority
    await priorityInput.fill("");
    await priorityInput.dispatchEvent("change");

    // Should show success notification about removal
    await expectNotification(page, "success", "우선순위 해제");
  });

  test("search filters entries in the table", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    // Use search input
    const searchInput = page.locator(".search-input");
    await searchInput.fill("서울");

    // Should filter to only show matching entries
    const visibleRows = page.locator(".priority-table tbody tr");
    await expect(visibleRows).toHaveCount(1);
    await expect(visibleRows.first()).toContainText("서울대학교");
  });

  test("back button navigates to admin page", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    await page.getByRole("button", { name: "돌아가기" }).click();
    await expect(page).toHaveURL(/\/queue\/admin/);
  });

  test("reset all priorities for an inspection type", async ({ page }) => {
    // First set priorities for entries 1 and 2 via API
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/priority/${INSPECTION_TYPE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ num: 1, priority: 1 }),
    });
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/priority/${INSPECTION_TYPE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ num: 2, priority: 2 }),
    });

    await page.goto("/queue/priority");
    await waitForPageReady(page);
    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    // Verify priorities are set
    const row1 = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^1$/ }) });
    await expect(row1.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`)).toHaveValue("1");

    const row2 = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^2$/ }) });
    await expect(row2.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`)).toHaveValue("2");

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Reset all priorities via API (since the UI button is per-inspection-type within inspection-config)
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/priority/${INSPECTION_TYPE}/all`, {
      method: "DELETE",
      headers: { Cookie: getAuthCookie("operationsManager") },
    });

    // Reload and verify priorities are cleared
    await page.reload();
    await waitForPageReady(page);
    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    const row1After = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^1$/ }) });
    await expect(row1After.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`)).toHaveValue("");

    const row2After = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^2$/ }) });
    await expect(row2After.locator(`.priority-input[data-inspection="${INSPECTION_TYPE}"]`)).toHaveValue("");
  });

  test("reset inspection history via button", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Find the first history reset button in the table header
    const historyResetBtn = page.locator(".priority-table:not([data-table-head-copy]) .btn-th-history").first();
    await expect(historyResetBtn).toBeVisible();
    await historyResetBtn.click();

    // Verify success notification
    await expectNotification(page, "success", "이력을 초기화했습니다");
  });

  test("arrow keys move focus between priority inputs", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);
    await expect(page.locator(".priority-table:not([data-table-head-copy])")).toBeVisible({ timeout: 10000 });

    const row1 = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^1$/ }) });
    const row2 = page.locator("tr", { has: page.locator(".entry-num", { hasText: /^2$/ }) });
    const input1 = row1.locator(".priority-input").first();
    const input2 = row2.locator(".priority-input").first();

    // ArrowDown: entry 1 -> entry 2 within the same inspection column
    await input1.focus();
    await expect(input1).toBeFocused();
    await input1.press("ArrowDown");
    await expect(input2).toBeFocused();

    // ArrowUp: back to entry 1
    await input2.press("ArrowUp");
    await expect(input1).toBeFocused();

    // ArrowRight/ArrowLeft across inspection columns (only if more than one exists)
    const colCount = await row1.locator(".priority-input").count();
    if (colCount > 1) {
      await input1.press("ArrowRight");
      await expect(row1.locator(".priority-input").nth(1)).toBeFocused();
      await row1.locator(".priority-input").nth(1).press("ArrowLeft");
      await expect(input1).toBeFocused();
    }
  });

  test("shows inspection config toggles in table header", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Should show toggle controls in the table column headers
    const thControls = page.locator(".priority-table:not([data-table-head-copy]) .th-controls");
    await expect(thControls.first()).toBeVisible({ timeout: 10000 });
    const count = await thControls.count();
    expect(count).toBeGreaterThan(0);

    // Each column header should have toggle buttons
    const toggles = page.locator(".priority-table:not([data-table-head-copy]) .btn-th-toggle");
    const toggleCount = await toggles.count();
    expect(toggleCount).toBeGreaterThan(0);
  });

  test("toggle sort rule (ignore priority/reinspection)", async ({ page }) => {
    await page.goto("/queue/priority");
    await waitForPageReady(page);

    // Wait for toggle buttons in table headers to load
    const firstToggle = page.locator(".priority-table:not([data-table-head-copy]) .btn-th-toggle").first();
    await expect(firstToggle).toBeVisible({ timeout: 10000 });

    // Read initial state (active or not)
    const hadActiveClass = await firstToggle.evaluate((el) => el.classList.contains("active"));

    // Click to toggle
    await firstToggle.click();

    // Verify success notification
    await expectNotification(page, "success", hadActiveClass ? "무시" : "적용");

    // Verify class changed
    if (hadActiveClass) {
      await expect(firstToggle).not.toHaveClass(/active/);
    } else {
      await expect(firstToggle).toHaveClass(/active/);
    }

    // Restore original state
    const restorePromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/queue/admin/inspection/") && res.status() === 200);
    await firstToggle.click();
    await restorePromise;
  });
});
