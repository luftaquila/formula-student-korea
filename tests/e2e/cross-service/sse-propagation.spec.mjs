import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = new Date().getFullYear();

test.describe("Cross-service SSE propagation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("traffic record addition propagates to score dashboard via SSE", async ({ page }) => {
    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    // Wait for the score table to load
    const table = page.locator(".score-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Verify entry 1 (서울대학교) is visible in the table
    await expect(table.locator("tbody")).toContainText("서울대학교");

    // Get initial state of event columns for entry 1
    const row = table.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(row).toBeVisible();

    // Add a traffic record via API (simulating a timing system recording a run)
    const headers = {
      "Content-Type": "application/json",
      Cookie: getAuthCookie("admin"),
    };

    const recordResponse = await fetch(`${BASE_URL}/traffic/api/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "E2E SSE Test",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 5432, // 5.432 seconds in milliseconds
        },
      }),
    });

    expect(recordResponse.status).toBe(201);

    // Wait for SSE propagation: the score dashboard should update
    // The traffic:records SSE event triggers debouncedLoadData() which re-fetches all score data
    // After reload, the 가속 column for team 1 should show the record time
    await expect(async () => {
      // Look for the record value in the team row
      // In "record" display mode, the time is shown as formatted milliseconds
      const rowContent = await row.textContent();
      // 5432ms = 5.432s, displayed as "5.432" or similar
      expect(rowContent).toContain("5.432");
    }).toPass({ timeout: 10000 });
  });

  test("inspection category result change propagates to score dashboard via SSE", async ({ page }) => {
    // First, get the category IDs from the inspection template
    const headers = {
      "Content-Type": "application/json",
      Cookie: getAuthCookie("admin"),
    };

    const templateRes = await fetch(
      `${BASE_URL}/inspection/api/sheet/template?year=${YEAR}`,
      { headers },
    );
    expect(templateRes.status).toBe(200);
    const template = await templateRes.json();

    // Get the first category (전기 검차)
    const category = template[0];
    expect(category).toBeTruthy();
    expect(category.name).toBe("전기 검차");
    const categoryId = category.id;

    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    // Wait for the score table to load
    const table = page.locator(".score-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Enable inspection columns if they are hidden
    const inspectionCheckbox = page.locator("input[type='checkbox']").first();
    const isChecked = await inspectionCheckbox.isChecked();
    if (!isChecked) {
      await inspectionCheckbox.check();
    }

    // Verify the inspection category column is visible
    const inspectionHeader = page.locator("th.col-inspection").filter({ hasText: "전기 검차" });
    await expect(inspectionHeader).toBeVisible();

    // Get team 1's initial inspection result
    const teamRow = table.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(teamRow).toBeVisible();

    // Set the category result via API
    const setResultRes = await fetch(
      `${BASE_URL}/inspection/api/sheet/category-result`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: 1,
          category_id: categoryId,
          result: "PASS",
        }),
      },
    );
    expect(setResultRes.status).toBe(200);

    // Wait for SSE propagation: the inspection column should update with PASS badge
    // The inspection:category-result SSE event directly updates the inspection state
    await expect(teamRow.locator(".badge-success")).toContainText("PASS", { timeout: 10000 });

    // Now change it to FAIL and verify SSE propagation
    const setFailRes = await fetch(
      `${BASE_URL}/inspection/api/sheet/category-result`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: 1,
          category_id: categoryId,
          result: "FAIL",
        }),
      },
    );
    expect(setFailRes.status).toBe(200);

    // Wait for FAIL to appear
    await expect(teamRow.locator(".badge-danger")).toContainText("FAIL", { timeout: 10000 });

    // Clean up: clear the category result
    await fetch(`${BASE_URL}/inspection/api/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        year: YEAR,
        team_num: 1,
        category_id: categoryId,
        result: "",
      }),
    });
  });

  test("multiple SSE events are correctly propagated", async ({ page }) => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: getAuthCookie("admin"),
    };

    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    const table = page.locator(".score-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Add a traffic record for a different team (team 2)
    const response = await fetch(`${BASE_URL}/traffic/api/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "E2E SSE Test",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 2, univ: "한양대학교", team: "ACES" },
          result: 6789, // 6.789 seconds
        },
      }),
    });
    expect(response.status).toBe(201);

    // Wait for the score table to update with team 2's record
    const team2Row = table.locator("tr.team-row").filter({ hasText: "한양대학교" });
    await expect(async () => {
      const rowContent = await team2Row.textContent();
      expect(rowContent).toContain("6.789");
    }).toPass({ timeout: 10000 });

    // Clean up: delete the test record table
    await fetch(
      `${BASE_URL}/traffic/api/records/${encodeURIComponent(`FSK ${YEAR} E2E SSE Test`)}`,
      { method: "DELETE", headers },
    );
  });
});
