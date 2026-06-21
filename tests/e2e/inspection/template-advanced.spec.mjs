import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Inspection template advanced features", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("pdf_include toggle via API persists correctly", async ({ page }) => {
    // Get the current template to find category IDs
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    expect(template.length).toBeGreaterThanOrEqual(2);

    const firstCategory = template[0];
    expect(firstCategory.pdf_include).toBe(1);

    // Toggle pdf_include off for the first category
    const updateRes = await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: false },
    });
    expect(updateRes.status()).toBe(200);

    // Verify it persists
    const verifyRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const updated = await verifyRes.json();
    expect(updated[0].pdf_include).toBe(0);

    // Restore: toggle back on
    await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: true },
    });

    // Verify restoration
    const restoreRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const restored = await restoreRes.json();
    expect(restored[0].pdf_include).toBe(1);
  });

  test("pdf_include preserved in JSON export", async ({ page }) => {
    // Get template to find first category ID
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstCategory = template[0];

    // Set pdf_include to 0 for first category
    await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: false },
    });

    // Navigate to template page and export JSON
    await page.goto("/inspection/template");
    await waitForPageReady(page);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("button").filter({ hasText: "JSON 내보내기" }).click();
    const download = await downloadPromise;

    // Read and verify pdf_include values
    const content = await download.createReadStream().then((stream) => {
      return new Promise((resolve) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => resolve(data));
      });
    });

    const parsed = JSON.parse(content);
    expect(parsed[0].pdf_include).toBe(0);
    expect(parsed[1].pdf_include).toBe(1);

    // Restore
    await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: true },
    });
  });

  test("bulk-answers API returns correct team answers", async ({ page }) => {
    // Get template to find item IDs
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const items = template[0].subcategories[0].groups[0].items;
    expect(items.length).toBeGreaterThanOrEqual(2);

    const item1 = items[0]; // 절연 저항 측정 (number)
    const item2 = items[1]; // 전압 확인 (passfail)

    // Dedicated team numbers for this test so it can't be clobbered by other
    // inspection specs writing answers in parallel (sheet-fill uses team 1,
    // realtime-sync uses team 2). The answer table keys on team_num with no
    // FK to entries, so unseeded high numbers are fine.
    const TEAM_A = 101;
    const TEAM_B = 102;

    // Read current values and pick different ones to avoid stale data
    const curBulk = await page.request.get(
      `/inspection/api/sheet/bulk-answers?year=${YEAR}&item_ids=${item1.id},${item2.id}`,
    );
    const curData = await curBulk.json();
    const val1 = curData[TEAM_A]?.[item1.id] === "42.5" ? "55.0" : "42.5";
    const val2 = curData[TEAM_A]?.[item2.id] === "PASS" ? "FAIL" : "PASS";
    const val3 = curData[TEAM_B]?.[item1.id] === "38.2" ? "60.0" : "38.2";

    // Set answers for TEAM_A (both items) and TEAM_B (one item)
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_A, item_id: item1.id, value: val1 },
    });
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_A, item_id: item2.id, value: val2 },
    });
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_B, item_id: item1.id, value: val3 },
    });

    // Fetch bulk answers
    const bulkRes = await page.request.get(
      `/inspection/api/sheet/bulk-answers?year=${YEAR}&item_ids=${item1.id},${item2.id}`,
    );
    expect(bulkRes.status()).toBe(200);
    const data = await bulkRes.json();

    // Verify TEAM_A has both answers
    expect(data[TEAM_A]).toBeTruthy();
    expect(data[TEAM_A][item1.id]).toBe(val1);
    expect(data[TEAM_A][item2.id]).toBe(val2);

    // Verify TEAM_B has only one answer
    expect(data[TEAM_B]).toBeTruthy();
    expect(data[TEAM_B][item1.id]).toBe(val3);
    expect(data[TEAM_B][item2.id]).toBeUndefined();

    // Clean up answers
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_A, item_id: item1.id, value: "" },
    });
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_A, item_id: item2.id, value: "" },
    });
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM_B, item_id: item1.id, value: "" },
    });
  });

  test("bulk-answers rejects invalid requests", async ({ page }) => {
    // Missing year parameter
    const res1 = await page.request.get("/inspection/api/sheet/bulk-answers?item_ids=1,2");
    expect(res1.status()).toBe(400);

    // Missing item_ids parameter
    const res2 = await page.request.get(`/inspection/api/sheet/bulk-answers?year=${YEAR}`);
    expect(res2.status()).toBe(400);

    // Invalid item_ids
    const res3 = await page.request.get(`/inspection/api/sheet/bulk-answers?year=${YEAR}&item_ids=abc`);
    expect(res3.status()).toBe(400);
  });

  test("cross-year template copy fails when target has existing template", async ({ page }) => {
    // Try to copy to the current year (which already has a template)
    const res = await page.request.post("/inspection/api/sheet/template/copy", {
      data: { from_year: YEAR, to_year: YEAR },
    });
    expect(res.status()).toBe(400);
  });

  test("pdf_include value preserved in cross-year copy", async ({ page }) => {
    const targetYear = YEAR + 3;

    // Get template and set first category's pdf_include to 0
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstCategory = template[0];

    await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: false },
    });

    // Copy to target year
    const copyRes = await page.request.post("/inspection/api/sheet/template/copy", {
      data: { from_year: YEAR, to_year: targetYear },
    });
    expect(copyRes.status()).toBe(201);

    // Verify pdf_include values in copied template
    const copiedRes = await page.request.get(`/inspection/api/sheet/template?year=${targetYear}`);
    const copied = await copiedRes.json();
    expect(copied[0].pdf_include).toBe(0);
    expect(copied[1].pdf_include).toBe(1);

    // Clean up: delete target year template and restore pdf_include
    await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: targetYear, template: [] },
    });
    await page.request.put(`/inspection/api/sheet/template/${firstCategory.id}`, {
      data: { pdf_include: true },
    });
  });

  test("blocks modification of past year template via API", async ({ page }) => {
    const pastYear = YEAR - 1;

    // Import a minimal template to the past year
    await page.request.post("/inspection/api/sheet/template/import", {
      data: {
        year: pastYear,
        template: [{ name: "과거 카테고리", subcategories: [] }],
      },
    });

    // Get the node ID
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${pastYear}`);
    const template = await templateRes.json();
    expect(template.length).toBe(1);
    const nodeId = template[0].id;

    // Attempt to delete the past year node — should be blocked
    const deleteRes = await page.request.delete(`/inspection/api/sheet/template/${nodeId}`);
    expect(deleteRes.status()).toBe(400);
    const text = await deleteRes.text();
    expect(text).toContain("이전 연도 템플릿은 수정할 수 없습니다.");

    // Clean up: import empty to clear the past year template
    await page.request.post("/inspection/api/sheet/template/import", {
      data: { year: pastYear, template: [] },
    });
  });
});
