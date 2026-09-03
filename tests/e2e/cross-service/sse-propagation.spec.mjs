import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";
import { completeInspectionCategory, restoreInspectionAnswers } from "../helpers/inspection.mjs";

const YEAR = currentCompetitionYear();

test.describe("Cross-service SSE propagation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("traffic record addition propagates to score dashboard via SSE", async ({ page }) => {
    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    // Wait for the score table to load
    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    // Use team 10 (KAIST) which has no prior 가속 records from other tests
    await expect(table.locator("tbody")).toContainText("KAIST");

    const row = table.locator("tr.team-row").filter({ hasText: "KAIST" });
    await expect(row).toBeVisible();

    // Add a traffic record via API (simulating a timing system recording a run)
    const headers = {
      "Content-Type": "application/json",
      Cookie: getAuthCookie("admin"),
    };

    const recordResponse = await fetch(`${BASE_URL}/competition/api/v1/traffic/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "E2E SSE Test",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(10),
          result: 5432, // 5.432 seconds in milliseconds
        },
      }),
    });

    expect(recordResponse.status).toBe(201);

    // Wait for SSE propagation: the score dashboard should update
    await expect(async () => {
      const rowContent = await row.textContent();
      // 5432ms displayed as "00:05.432" in mm:ss.SSS format
      expect(rowContent).toContain("05.432");
    }).toPass({ timeout: 10000 });
  });

  test("inspection category result change propagates to score dashboard via SSE", async ({ page }) => {
    const teamNum = 20;
    // First, get the category IDs from the inspection template
    const headers = {
      "Content-Type": "application/json",
      Cookie: getAuthCookie("admin"),
    };

    const templateRes = await fetch(
      `${BASE_URL}/competition/api/v1/inspection/sheet/template?year=${YEAR}`,
      { headers },
    );
    expect(templateRes.status).toBe(200);
    const template = await templateRes.json();

    // Get the first category (전기 검차)
    const category = template[0];
    expect(category).toBeTruthy();
    expect(category.name).toBe("전기 검차");
    const categoryId = category.id;
    const completionChanges = await completeInspectionCategory({
      year: YEAR,
      teamNum,
      category,
      profile: "admin",
    });

    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    // Wait for the score table to load
    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    // Enable inspection columns if they are hidden
    const inspectionCheckbox = page.locator(".filter-bar").locator("label.filter-checkbox").filter({ hasText: "검차" }).locator("input[type='checkbox']");
    if (!(await inspectionCheckbox.isChecked())) {
      await inspectionCheckbox.check();
    }

    // Verify the inspection category column is visible
    const inspectionHeader = scoreTable(page).locator("th.col-inspection").filter({ hasText: "전기 검차" });
    await expect(inspectionHeader).toBeVisible();

    // Use a base-seeded team that no other cross-service inspection spec mutates.
    const teamRow = table.locator("tr.team-row").filter({ hasText: "고려대학교" });
    await expect(teamRow).toBeVisible();

    // Set the category result via API
    const setResultRes = await fetch(
      `${BASE_URL}/competition/api/v1/inspection/sheet/category-result`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: teamNum,
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
      `${BASE_URL}/competition/api/v1/inspection/sheet/category-result`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          year: YEAR,
          team_num: teamNum,
          category_id: categoryId,
          result: "FAIL",
        }),
      },
    );
    expect(setFailRes.status).toBe(200);

    // Wait for FAIL to appear
    await expect(teamRow.locator(".badge-danger")).toContainText("FAIL", { timeout: 10000 });

    // Clean up: clear the category result
    await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        year: YEAR,
        team_num: teamNum,
        category_id: categoryId,
        result: "",
      }),
    });
    await restoreInspectionAnswers({
      year: YEAR,
      teamNum,
      changes: completionChanges,
      profile: "admin",
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

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    // Add a traffic record for a different team (team 2)
    const response = await fetch(`${BASE_URL}/competition/api/v1/traffic/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "E2E SSE Test",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(2),
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
      `${BASE_URL}/competition/api/v1/traffic/records/${encodeURIComponent(`FSK ${YEAR} E2E SSE Test`)}`,
      { method: "DELETE", headers },
    );
  });
});
