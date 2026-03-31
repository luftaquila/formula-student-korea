import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;

test.describe("Inspection year switch and read-only mode", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed entries and template for previous year
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create vehicle types and entries for previous year
    await page.request.post(`/entry/api/vehicle-types?year=${PREV_YEAR}`, { data: { name: "EV" } });
    await page.request.post(`/entry/api/entries?year=${PREV_YEAR}`, {
      data: { num: 80, univ: "과거검차대학교", team: "Old Team", type: "EV" },
    });

    // Create a minimal template for previous year
    await page.request.post("/inspection/api/sheet/template/import", {
      data: {
        year: PREV_YEAR,
        template: [
          {
            name: "과거 전기 검차",
            remarks: "",
            pdf_include: 1,
            subcategories: [
              {
                name: "과거 배터리",
                remarks: "",
                groups: [
                  {
                    name: "과거 팩",
                    remarks: "",
                    items: [{ name: "과거 전압", answer_type: "passfail" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Clean up previous year data
    await page.request.delete(`/entry/api/entries?year=${PREV_YEAR}`);
    await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: PREV_YEAR, template: [] },
    });

    await context.close();
  });

  test("summary page: year dropdown switches data and shows read-only banner", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);

    // Current year should show 5 seeded teams
    const table = page.locator(".sheet-table");
    await expect(table.locator("tbody tr.clickable-row")).toHaveCount(8);

    // No read-only banner for current year
    await expect(page.locator(".readonly-banner")).not.toBeVisible();

    // Year dropdown should be visible
    const yearSelect = page.locator(".filter-bar select.filter-input");
    await expect(yearSelect).toBeVisible();

    // Switch to previous year
    await yearSelect.selectOption(String(PREV_YEAR));
    await waitForPageReady(page);

    // Should show the 1 entry for previous year
    await expect(table.locator("tbody tr.clickable-row")).toHaveCount(1);
    await expect(table.locator("tbody")).toContainText("과거검차대학교");

    // Read-only banner should appear
    await expect(page.locator(".readonly-banner")).toBeVisible();
    await expect(page.locator(".readonly-banner")).toContainText("읽기 전용");

    // Switch back to current year
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);

    // Banner should disappear, data should restore
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
    await expect(table.locator("tbody tr.clickable-row")).toHaveCount(8);
  });

  test("template page: year dropdown switches data and shows read-only banner", async ({ page }) => {
    await page.goto("/inspection/template");
    await waitForPageReady(page);

    // Current year should show template tabs for seeded categories
    await expect(page.locator(".tab").filter({ hasText: "전기 검차" })).toBeVisible();
    await expect(page.locator(".tab").filter({ hasText: "샤시 검차" })).toBeVisible();

    // No read-only banner
    await expect(page.locator(".readonly-banner")).not.toBeVisible();

    // Switch to previous year
    const yearSelect = page.locator(".filter-bar select.filter-input");
    await yearSelect.selectOption(String(PREV_YEAR));
    await waitForPageReady(page);

    // Should show previous year's template
    await expect(page.locator(".tab").filter({ hasText: "과거 전기 검차" })).toBeVisible();

    // Read-only banner should appear
    await expect(page.locator(".readonly-banner")).toBeVisible();
    await expect(page.locator(".readonly-banner")).toContainText("읽기 전용");

    // Add category button should not be visible in read-only mode
    await expect(page.locator(".tab-add")).not.toBeVisible();

    // Switch back
    await yearSelect.selectOption(String(YEAR));
    await waitForPageReady(page);
    await expect(page.locator(".readonly-banner")).not.toBeVisible();
  });

  test("sheet detail page for past year is read-only", async ({ page }) => {
    // Navigate directly to past year sheet detail
    await page.goto(`/inspection/${PREV_YEAR}/80`);
    await waitForPageReady(page);

    // Verify team header shows the entry
    await expect(page.locator(".team-header")).toContainText("#80");
    await expect(page.locator(".team-header")).toContainText("과거검차대학교");

    // Read-only banner should be visible
    await expect(page.locator(".readonly-banner")).toBeVisible();

    // All input fields should be disabled
    const inputs = page.locator(".sheet-content input:not([type='hidden'])");
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }

    // PASS/FAIL buttons should be disabled
    const passfailBtns = page.locator(".passfail-btn");
    const btnCount = await passfailBtns.count();
    for (let i = 0; i < btnCount; i++) {
      await expect(passfailBtns.nth(i)).toBeDisabled();
    }
  });
});
