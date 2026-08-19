import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-Invalidation-Score`;

test.describe("Traffic record invalidation -> Score recalculation", () => {
  test.use({ storageState: storageStatePath("admin") });

  let fastRowid;
  let slowRowid;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create fast record (4000ms) for team 31
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Invalidation-Score",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(31),
          result: 4000,
          detail: "fast run",
        },
      },
    });

    // Create slow record (7000ms) for team 31
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Invalidation-Score",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(31),
          result: 7000,
          detail: "slow run",
        },
      },
    });

    // Get rowids
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const fastRecord = records.find((r) => r.result === 4000);
    const slowRecord = records.find((r) => r.result === 7000);
    fastRowid = fastRecord.rowid;
    slowRowid = slowRecord.rowid;

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    await context.close();
  });

  test("invalidating best record updates score dashboard via SSE", async ({ page }) => {
    // Open score dashboard
    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    const teamRow = table.locator("tr.team-row").filter({ hasText: "연세대학교" });
    await expect(teamRow).toBeVisible();

    // Initially best record should be 4000ms (04.000)
    await expect(async () => {
      const text = await teamRow.textContent();
      expect(text).toContain("04.000");
    }).toPass({ timeout: 10000 });

    // Invalidate the fast record
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${fastRowid}`, {
      data: { field: "invalidated" },
    });

    // Score should update to show slow record (07.000)
    await expect(async () => {
      const text = await teamRow.textContent();
      expect(text).toContain("07.000");
    }).toPass({ timeout: 10000 });

    // Un-invalidate the fast record
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${fastRowid}`, {
      data: { field: "invalidated" },
    });

    // Score should revert to fast record (04.000)
    await expect(async () => {
      const text = await teamRow.textContent();
      expect(text).toContain("04.000");
    }).toPass({ timeout: 10000 });
  });
});
