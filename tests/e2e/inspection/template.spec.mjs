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
    const panel = page.locator(".category-panel");

    // Edit the subcategory name (배터리 → 배터리2)
    const subNameInput = panel.locator(".sub-name").first();
    await expect(subNameInput).toHaveValue("배터리");
    const savePromise = page.waitForResponse((res) => res.url().includes("/api/sheet/template/") && res.status() === 200);
    await subNameInput.fill("배터리2");
    await subNameInput.blur();
    await savePromise;

    // Verify the value persists after reload
    await page.reload();
    await waitForPageReady(page);
    const reloadedInput = page.locator(".category-panel .sub-name").first();
    await expect(reloadedInput).toHaveValue("배터리2");

    // Revert: change back to original
    const restorePromise = page.waitForResponse((res) => res.url().includes("/api/sheet/template/") && res.status() === 200);
    await reloadedInput.fill("배터리");
    await reloadedInput.blur();
    await restorePromise;
  });

  test("copies template between years via API", async ({ page }) => {
    // Copy current year's template to (current year + 1) via API
    const targetYear = YEAR + 1;
    const response = await page.request.post("/inspection/api/sheet/template/copy", {
      data: { from_year: YEAR, to_year: targetYear },
    });
    expect(response.status()).toBe(201);

    // Verify copied template via API (dropdown won't show year without entry data)
    const verifyRes = await page.request.get(`/inspection/api/sheet/template?year=${targetYear}`);
    const copied = await verifyRes.json();
    expect(copied.length).toBe(2);
    expect(copied[0].name).toBe("전기 검차");
    expect(copied[1].name).toBe("샤시 검차");

    // Clean up: delete the target year's template by importing empty
    await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: targetYear, template: [] },
    });
  });

  test("reorders template items via API", async ({ page }) => {
    // Get current template to find item IDs
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();

    // Find items in the first group of first subcategory
    const firstGroup = template[0]?.subcategories?.[0]?.groups?.[0];
    expect(firstGroup).toBeTruthy();
    expect(firstGroup.items.length).toBeGreaterThanOrEqual(2);

    // Build items array with reversed sort_order
    const items = firstGroup.items.map((item) => ({ id: item.id, sort_order: item.sort_order }));
    const reversedItems = items.map((item, i) => ({ id: item.id, sort_order: items[items.length - 1 - i].sort_order }));

    // Call reorder API
    const reorderRes = await page.request.post("/inspection/api/sheet/template/reorder", {
      data: { items: reversedItems },
    });
    expect(reorderRes.status()).toBe(200);

    // Verify new order via API
    const updatedRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const updated = await updatedRes.json();
    const updatedItems = updated[0].subcategories[0].groups[0].items;
    const reversedIds = [...items].reverse().map((i) => i.id);
    expect(updatedItems.map((i) => i.id)).toEqual(reversedIds);

    // Restore original order
    const restoreItems = items.map((item) => ({ id: item.id, sort_order: item.sort_order }));
    await page.request.post("/inspection/api/sheet/template/reorder", {
      data: { items: restoreItems },
    });
  });

  test("imports template from JSON via API", async ({ page }) => {
    const importYear = YEAR + 2;
    const importTemplate = [
      {
        name: "E2E Import 카테고리",
        subcategories: [
          {
            name: "E2E 소분류",
            groups: [
              {
                name: "E2E 그룹",
                items: [{ name: "E2E 항목", answer_type: "passfail" }],
              },
            ],
          },
        ],
      },
    ];

    // Import template
    const importRes = await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: importYear, template: importTemplate },
    });
    expect(importRes.status()).toBe(201);

    // Verify imported template via API (dropdown won't show year without entry data)
    const verifyRes = await page.request.get(`/inspection/api/sheet/template?year=${importYear}`);
    const imported = await verifyRes.json();
    expect(imported.length).toBe(1);
    expect(imported[0].name).toBe("E2E Import 카테고리");
    expect(imported[0].subcategories[0].name).toBe("E2E 소분류");

    // Cleanup: delete the imported year's template
    await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: importYear, template: [] },
    });
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

  test("adds an item with text answer type via API", async ({ page }) => {
    // Get current template to find the group ID
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const groupId = template[0].subcategories[0].groups[0].id;

    // Add a text-type item
    const createRes = await page.request.post("/inspection/api/sheet/template", {
      data: { year: YEAR, level: "item", parent_id: groupId, name: "E2E 텍스트 항목", answer_type: "text" },
    });
    expect(createRes.status()).toBe(200);
    const { id: itemId } = await createRes.json();

    // Verify the item was created with correct answer_type
    const verifyRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const updated = await verifyRes.json();
    const items = updated[0].subcategories[0].groups[0].items;
    const newItem = items.find((i) => i.id === itemId);
    expect(newItem).toBeTruthy();
    expect(newItem.answer_type).toBe("text");

    // Clean up: delete the item
    const deleteRes = await page.request.delete(`/inspection/api/sheet/template/${itemId}`);
    expect(deleteRes.status()).toBe(200);
  });

  test("adds an item with checktable answer type via API", async ({ page }) => {
    // Get current template to find the group ID in second category
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const groupId = template[1].subcategories[0].groups[0].id;

    // Add a checktable-type item with remarks JSON
    const remarks = JSON.stringify({ columns: ["항목A", "항목B"], rows: ["행1", "행2"] });
    const createRes = await page.request.post("/inspection/api/sheet/template", {
      data: { year: YEAR, level: "item", parent_id: groupId, name: "E2E 체크테이블", answer_type: "checktable", remarks },
    });
    expect(createRes.status()).toBe(200);
    const { id: itemId } = await createRes.json();

    // Verify the item was created with correct answer_type and remarks
    const verifyRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const updated = await verifyRes.json();
    const items = updated[1].subcategories[0].groups[0].items;
    const newItem = items.find((i) => i.id === itemId);
    expect(newItem).toBeTruthy();
    expect(newItem.answer_type).toBe("checktable");
    expect(JSON.parse(newItem.remarks)).toEqual({ columns: ["항목A", "항목B"], rows: ["행1", "행2"] });

    // Clean up: delete the item
    const deleteRes = await page.request.delete(`/inspection/api/sheet/template/${itemId}`);
    expect(deleteRes.status()).toBe(200);
  });
});
