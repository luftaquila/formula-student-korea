import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const TABLE_NAME = `FSK ${YEAR} E2E-SB-Live`;

test.describe("Traffic scoreboard live updates", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed initial record
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-SB-Live",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
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
    await page.request.delete(`/traffic/api/records/${TABLE_NAME}`);
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
    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-SB-Live",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 2, univ: "한양대학교", team: "ACES" },
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
    const recordsRes = await page.request.get(`/traffic/api/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const entry2Record = records.find((r) => r.num === 2);
    expect(entry2Record).toBeTruthy();

    // Toggle scoreboard off for entry 2's record
    await page.request.patch(`/traffic/api/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "scoreboard", value: 0 },
    });

    // Verify entry 2's record disappears from scoreboard (SSE update)
    await expect(async () => {
      const scoreboardText = await scoreboard.textContent();
      expect(scoreboardText).not.toContain("한양대학교");
    }).toPass({ timeout: 10000 });

    // Restore: toggle scoreboard back on
    await page.request.patch(`/traffic/api/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "scoreboard", value: 1 },
    });

    // Verify it reappears
    await expect(scoreboard).toContainText("한양대학교", { timeout: 10000 });
  });

  test("invalidating a record auto-removes from scoreboard", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    const fileSelect = page.locator(".form-select").first();
    await fileSelect.selectOption(TABLE_NAME);

    const scoreboard = page.locator(".scoreboard");
    await expect(scoreboard).toBeVisible({ timeout: 5000 });
    await expect(scoreboard).toContainText("한양대학교");

    // Get entry 2's record rowid
    const recordsRes = await page.request.get(`/traffic/api/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const entry2Record = records.find((r) => r.num === 2);

    // Invalidate entry 2's record (this should auto-set scoreboard=0)
    await page.request.patch(`/traffic/api/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "invalidated" },
    });

    // Verify entry 2 disappears from scoreboard
    await expect(async () => {
      const text = await scoreboard.textContent();
      expect(text).not.toContain("한양대학교");
    }).toPass({ timeout: 10000 });

    // Restore: un-invalidate (toggles back)
    await page.request.patch(`/traffic/api/records/${TABLE_NAME}/${entry2Record.rowid}`, {
      data: { field: "invalidated" },
    });

    // Verify it reappears
    await expect(scoreboard).toContainText("한양대학교", { timeout: 10000 });
  });
});
