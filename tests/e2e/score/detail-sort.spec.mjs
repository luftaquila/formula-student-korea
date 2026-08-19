import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-Sort-Test`;

test.describe("Score detail sort mode toggle", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed traffic records for a team so the detail panel has data to sort
  test.beforeAll(async () => {
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };

    // Add multiple records for team 1 with different results
    const records = [
      { result: 65000, detail: "run1" },
      { result: 60000, detail: "run2" },
      { result: 58000, detail: "run3" },
    ];

    for (const record of records) {
      await fetch(`${BASE_URL}/competition/api/v1/traffic/records`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "E2E-Sort-Test",
          data: {
            time: new Date().toISOString(),
            type: "가속",
            entry: await trafficEntry(1),
            result: record.result,
            detail: record.detail,
          },
        }),
      });
    }

    // Set cones/oc on some records to differentiate time vs score ordering
    const recordsRes = await fetch(`${BASE_URL}/competition/api/v1/traffic/records/${encodeURIComponent(TABLE_NAME)}`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const allRecords = await recordsRes.json();

    // Set 2 cones on the fastest record (58000) so it's not the best by score
    const fastestRecord = allRecords.find((r) => r.result === 58000);
    if (fastestRecord) {
      await fetch(`${BASE_URL}/competition/api/v1/traffic/records/${encodeURIComponent(TABLE_NAME)}/${fastestRecord.rowid}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ field: "cones", value: 5 }),
      });
    }
  });

  test.afterAll(async () => {
    await fetch(`${BASE_URL}/competition/api/v1/traffic/records/${encodeURIComponent(TABLE_NAME)}`, {
      method: "DELETE",
      headers: { Cookie: getAuthCookie("admin") },
    });
  });

  test("detail sort toggle switches between time and score order", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);

    // Click team 1 row (서울대학교) to expand detail
    const teamRow = page.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(teamRow).toBeVisible();
    await teamRow.click();
    await expect(teamRow).toHaveClass(/expanded-row/);

    // Detail row should appear with runs table
    const detailRow = page.locator("tr.detail-row").first();
    await expect(detailRow).toBeVisible();

    // Find the sort toggle buttons
    const timeSortBtn = detailRow.locator(".detail-sort-btn").filter({ hasText: "시간순" });
    const scoreSortBtn = detailRow.locator(".detail-sort-btn").filter({ hasText: "성적순" });
    await expect(timeSortBtn).toBeVisible();
    await expect(scoreSortBtn).toBeVisible();

    // Default mode is "시간순" (time)
    await expect(timeSortBtn).toHaveClass(/active/);
    await expect(scoreSortBtn).not.toHaveClass(/active/);

    // Switch to score sort mode
    await scoreSortBtn.click();
    await expect(scoreSortBtn).toHaveClass(/active/);
    await expect(timeSortBtn).not.toHaveClass(/active/);

    // Switch back to time sort mode
    await timeSortBtn.click();
    await expect(timeSortBtn).toHaveClass(/active/);
    await expect(scoreSortBtn).not.toHaveClass(/active/);
  });
});
