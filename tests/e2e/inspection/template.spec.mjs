import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Inspection template management", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/inspection/template");
    await waitForPageReady(page);
  });

  test("renders template tree with seeded categories", async ({ page }) => {
    // Verify the two seeded category tabs are visible
    const tabs = page.locator(".tabs .tab:not(.tab-add)");
    await expect(tabs).toHaveCount(2);

    // Verify category names (Roman numeral prefix + name)
    await expect(tabs.nth(0)).toContainText("전기 검차");
    await expect(tabs.nth(1)).toContainText("샤시 검차");

    // First tab is active by default; verify subcategory content renders
    const panel = page.locator(".category-panel");
    await expect(panel).toBeVisible();

    // Names are in input fields (v-model), not plain text — use toHaveValue
    await expect(panel.locator(".sub-name").first()).toHaveValue("배터리");
    await expect(panel.locator(".grp-name").first()).toHaveValue("배터리 팩");
  });

  test("switches between category tabs", async ({ page }) => {
    const tabs = page.locator(".tabs .tab:not(.tab-add)");

    // Click second tab (샤시 검차)
    await tabs.nth(1).click();

    const panel = page.locator(".category-panel");
    await expect(panel.locator(".sub-name").first()).toHaveValue("프레임");
    await expect(panel.locator(".grp-name").first()).toHaveValue("롤바");
  });

  test("adds a new category", async ({ page }) => {
    const tabsBefore = page.locator(".tabs .tab:not(.tab-add)");
    const countBefore = await tabsBefore.count();

    // Click the "+" button to add a category
    await page.locator(".tab-add").click();

    // Verify a new tab appeared
    const tabsAfter = page.locator(".tabs .tab:not(.tab-add)");
    await expect(tabsAfter).toHaveCount(countBefore + 1);

    // The new tab should be active and contain the default name
    const newTab = tabsAfter.nth(countBefore);
    await expect(newTab).toContainText("새 카테고리");
    await expect(newTab).toHaveClass(/active/);

    // The panel should show the new category's name input
    const nameInput = page.locator(".category-header .cat-name");
    await expect(nameInput).toHaveValue("새 카테고리");

    // Clean up: delete the new category
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator(".category-header .btn-danger").click();
    await expect(page.locator(".tabs .tab:not(.tab-add)")).toHaveCount(countBefore);
  });

  test("adds a subcategory under a category", async ({ page }) => {
    // Click the "+ 소분류" button in the category body
    const addSubBtn = page.locator(".category-body > .add-child-btn").filter({ hasText: "소분류" });
    await addSubBtn.click();

    // Verify the new subcategory appeared
    const panel = page.locator(".category-panel");
    const subInputs = panel.locator(".sub-name");
    const lastSubInput = subInputs.last();
    await expect(lastSubInput).toHaveValue("새 소분류");

    // Clean up: delete the new subcategory
    page.on("dialog", (dialog) => dialog.accept());
    const newSubSection = page.locator(".subcategory-section").last();
    await newSubSection.locator(".sub-row .btn-danger").click();
    await waitForPageReady(page);
  });

  test("deletes a node from the template", async ({ page }) => {
    // First add a temporary category to delete
    await page.locator(".tab-add").click();

    // Wait for the new tab to appear before counting
    const tabsAfterAdd = page.locator(".tabs .tab:not(.tab-add)");
    await expect(tabsAfterAdd.last()).toContainText("새 카테고리");
    const countAfterAdd = await tabsAfterAdd.count();

    // Delete the new category
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator(".category-header .btn-danger").click();

    // Verify the tab was removed
    await expect(page.locator(".tabs .tab:not(.tab-add)")).toHaveCount(countAfterAdd - 1);
  });

  test("edits a node name inline", async ({ page }) => {
    const suffix = `${Date.now()}`;
    const originalName = `E2E edit ${suffix}`;
    const updatedName = `E2E edited ${suffix}`;
    const create = await page.request.post("/inspection/api/sheet/template", {
      data: { year: YEAR, level: "category", name: originalName, sort_order: 999 },
    });
    expect(create.status()).toBe(200);
    const { id } = await create.json();

    try {
      await page.reload();
      await waitForPageReady(page);
      await page.locator(".tabs .tab").filter({ hasText: originalName }).click();

      const nameInput = page.locator(".category-header .cat-name");
      await expect(nameInput).toHaveValue(originalName);
      const savePromise = page.waitForResponse(
        (response) => response.url().endsWith(`/api/sheet/template/${id}`) && response.request().method() === "PUT",
      );
      await nameInput.fill(updatedName);
      await nameInput.blur();
      expect((await savePromise).status()).toBe(200);

      await page.reload();
      await waitForPageReady(page);
      await page.locator(".tabs .tab").filter({ hasText: updatedName }).click();
      await expect(page.locator(".category-header .cat-name")).toHaveValue(updatedName);
    } finally {
      const cleanup = await page.request.delete(`/inspection/api/sheet/template/${id}`);
      expect(cleanup.status()).toBe(200);
    }
  });

  test("opens print page with template data", async ({ page }) => {
    // The print page fetches the template on mount and only renders data once
    // it resolves. Use a generous auto-retry timeout instead of the default 5s
    // so a slow template fetch on CI doesn't flake the assertion.
    await page.goto(`/inspection/template/print?year=${YEAR}`);

    // Verify category data is rendered
    await expect(page.locator("body")).toContainText("전기 검차", { timeout: 15000 });
    await expect(page.locator("body")).toContainText("배터리", { timeout: 15000 });
  });

  test("exports template as JSON", async ({ page }) => {
    // Listen for the download event triggered by JSON export
    const downloadPromise = page.waitForEvent("download");

    // Click the "JSON 내보내기" button
    await page.locator("button").filter({ hasText: "JSON 내보내기" }).click();

    const download = await downloadPromise;

    // Verify the filename matches expected pattern
    expect(download.suggestedFilename()).toBe(`inspection-template-${YEAR}.json`);

    // Read and verify the downloaded JSON content
    const content = await download.createReadStream().then((stream) => {
      return new Promise((resolve) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => resolve(data));
      });
    });

    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe("전기 검차");
    expect(parsed[1].name).toBe("샤시 검차");

    // Verify nested structure
    expect(parsed[0].subcategories[0].name).toBe("배터리");
    expect(parsed[0].subcategories[0].groups[0].name).toBe("배터리 팩");
    expect(parsed[0].subcategories[0].groups[0].items).toHaveLength(4);
  });

});
