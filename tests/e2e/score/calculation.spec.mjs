import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();
const TABLE_NAME = `FSK ${YEAR} E2E-Score-Calc`;

test.describe("Score calculation accuracy", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed traffic records and score settings
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Create traffic records for team 1 (two runs with different cone counts)
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Score-Calc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 5000,
          detail: "run 1 - no cones",
        },
      },
    });

    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Score-Calc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 4000,
          detail: "run 2 - faster but has cones",
        },
      },
    });

    // Set cones on the second record (the faster one)
    const recordsRes = await page.request.get(`/competition/api/v1/traffic/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const run2 = records.find((r) => r.detail === "run 2 - faster but has cones");
    if (run2) {
      await page.request.patch(`/competition/api/v1/traffic/records/${TABLE_NAME}/${run2.rowid}`, {
        data: { field: "cones", value: 3 },
      });
    }

    // Create an explicit DNF attempt for team 2.
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Score-Calc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(2),
          result: null,
          status: "DNF",
          detail: "DNF run",
        },
      },
    });

    // Create traffic record for team 3 (normal run)
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Score-Calc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(3),
          result: 6000,
          detail: "normal run",
        },
      },
    });

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Clean up traffic records
    await page.request.delete(`/competition/api/v1/traffic/records/${TABLE_NAME}`);

    // Clean up penalties
    await page.request.put("/competition/api/v1/score/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
    });

    await context.close();
  });

  test("penalty-adjusted best record selection via API", async ({ page }) => {
    // Set cone penalty to 2 seconds for 가속
    await page.request.put("/competition/api/v1/score/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 2, oc_penalty: 0, start_delay: 0 },
    });

    // Fetch score data
    const res = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    const data = await res.json();

    // Find the 가속 event
    const accelEvent = data.events.find((e) => e.type === "가속");
    expect(accelEvent).toBeTruthy();

    // Team 1: Run 1 = 5000ms, Run 2 = 4000ms + 3 cones * 2s * 1000 = 4000 + 6000 = 10000ms adjusted
    // Best record should be Run 1 (5000ms adjusted < 10000ms adjusted)
    const team1Record = accelEvent.records["1"];
    expect(team1Record).toBeTruthy();
    expect(team1Record.result).toBe(5000);

    // Team 2: only has DNF, represented without a numeric sentinel.
    const team2Record = accelEvent.records["2"];
    expect(team2Record).toBeTruthy();
    expect(team2Record.result).toBeNull();
    expect(team2Record.status).toBe("DNF");

    // Team 3: Single valid run with 6000ms
    const team3Record = accelEvent.records["3"];
    expect(team3Record).toBeTruthy();
    expect(team3Record.result).toBe(6000);
  });

  test("penalty change affects best record selection", async ({ page }) => {
    // Set cone penalty to 0 (no penalty)
    await page.request.put("/competition/api/v1/score/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
    });

    // Fetch score data
    const res = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    const data = await res.json();

    const accelEvent = data.events.find((e) => e.type === "가속");
    expect(accelEvent).toBeTruthy();

    // Team 1: With 0 penalty, Run 2 (4000ms) is better than Run 1 (5000ms)
    const team1Record = accelEvent.records["1"];
    expect(team1Record).toBeTruthy();
    expect(team1Record.result).toBe(4000);
    expect(team1Record.cones).toBe(3);
  });

  test("score dashboard reflects traffic records", async ({ page }) => {
    // Set penalty back to 0 for clean display
    await page.request.put("/competition/api/v1/score/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
    });

    await page.goto("/score");
    await waitForPageReady(page);

    // The score table should show teams
    const table = scoreTable(page);
    await expect(table).toBeVisible();

    // Expand team 1's detail row to verify runs
    const team1Row = page.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(team1Row).toBeVisible();
    await team1Row.click();

    // Detail row should be visible with run data
    const detailRow = page.locator("tr.detail-row").first();
    await expect(detailRow).toBeVisible();

    // Collapse
    await team1Row.click();
  });

  test("SSE real-time update on score dashboard", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible();

    // Add a new traffic record for team 10 (KAIST)
    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Score-Calc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(10),
          result: 3500,
          detail: "SSE test record",
        },
      },
    });

    // Expand KAIST row and verify the new record appears via SSE
    const kaistRow = page.locator("tr.team-row").filter({ hasText: "KAIST" });
    await expect(kaistRow).toBeVisible();
    await kaistRow.click();

    // The detail row should eventually show the run data
    const detailRow = page.locator("tr.detail-row").first();
    await expect(detailRow).toBeVisible({ timeout: 10000 });

    // Collapse
    await kaistRow.click();
  });
});
