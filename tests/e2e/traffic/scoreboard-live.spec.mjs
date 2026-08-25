import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-SB-Live`;

test.describe("Traffic scoreboard live updates", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed initial record
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-SB-Live",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 5000,
          detail: "scoreboard live test 1",
        },
      },
    });

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    await context.close();
  });

  test("new record appears on scoreboard via SSE", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    // Select the record file
    const fileSelect = page.locator(".form-select").first();
    await fileSelect.selectOption(TABLE_NAME);

    // Wait for scoreboard to render with initial record
    const scoreboard = page.locator(".scoreboard");
    await expect(scoreboard).toBeVisible({ timeout: 5000 });
    await expect(scoreboard).toContainText("서울대학교");

    // Add a new record via API (SSE should push the update)
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-SB-Live",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(2),
          result: 4000,
          detail: "scoreboard live test 2",
        },
      },
    });

    // Verify new record appears on scoreboard via SSE
    await expect(scoreboard).toContainText("한양대학교", { timeout: 10000 });
  });

  test("scoreboard toggle hides record from scoreboard", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    // Select the record file
    const fileSelect = page.locator(".form-select").first();
    await fileSelect.selectOption(TABLE_NAME);

    // Wait for scoreboard
    const scoreboard = page.locator(".scoreboard");
    await expect(scoreboard).toBeVisible({ timeout: 5000 });

    // Verify 한양대학교 (entry 2, result 4000) is shown as best record
    await expect(scoreboard).toContainText("한양대학교");

    // Get records to find the entry 2 record's rowid
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const entry2Record = records.find((r) => r.num === 2);
    expect(entry2Record).toBeTruthy();

    // Toggle scoreboard off for entry 2's record
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "scoreboard", value: 0 },
    });

    // Verify entry 2's record disappears from scoreboard (SSE update)
    await expect(async () => {
      const scoreboardText = await scoreboard.textContent();
      expect(scoreboardText).not.toContain("한양대학교");
    }).toPass({ timeout: 10000 });

    // Restore: toggle scoreboard back on
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "scoreboard", value: 1 },
    });

    // Verify it reappears
    await expect(scoreboard).toContainText("한양대학교", { timeout: 10000 });
  });

  test("classifying a visible record keeps it on scoreboard and shows the status", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    const fileSelect = page.locator(".form-select").first();
    await fileSelect.selectOption(TABLE_NAME);

    const scoreboard = page.locator(".scoreboard");
    await expect(scoreboard).toBeVisible({ timeout: 5000 });
    await expect(scoreboard).toContainText("한양대학교");

    // Get entry 2's record rowid
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const entry2Record = records.find((r) => r.num === 2);

    // Classification does not alter independent scoreboard visibility.
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "status", value: "DSQ" },
    });

    // The team stays visible and its current record is rendered as DSQ.
    await expect(async () => {
      const text = await scoreboard.textContent();
      expect(text).toContain("한양대학교");
      expect(text).toContain("DSQ");
    }).toPass({ timeout: 10000 });

    // Restore the timed row to normal.
    await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "status", value: null },
    });

    // Verify it reappears
    await expect(scoreboard).toContainText("한양대학교", { timeout: 10000 });
  });
});
