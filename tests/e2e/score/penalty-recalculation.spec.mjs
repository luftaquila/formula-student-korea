import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const TABLE_NAME = `FSK ${YEAR} E2E-Penalty-Recalc`;

test.describe("Penalty change -> Score dashboard recalculation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Record A: 5000ms, 0 cones
    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Penalty-Recalc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 5000,
          detail: "record A - no cones",
        },
      },
    });

    // Record B: 4000ms, 3 cones
    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Penalty-Recalc",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 4000,
          detail: "record B - 3 cones",
        },
      },
    });

    // Set 3 cones on record B
    const recordsRes = await page.request.get(`/traffic/api/records/${TABLE_NAME}`);
    const records = await recordsRes.json();
    const recordB = records.find((r) => r.detail === "record B - 3 cones");
    if (recordB) {
      await page.request.patch(`/traffic/api/records/${TABLE_NAME}/${recordB.rowid}`, {
        data: { field: "cones", value: 3 },
      });
    }

    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/traffic/api/records/${TABLE_NAME}`);
    await page.request.put("/score/api/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
    });
    await context.close();
  });

  test("penalty change recalculates best record on score dashboard via SSE", async ({ page }) => {
    // Set cone_penalty=0: best = B (4000ms), no penalty adjustment
    await page.request.put("/score/api/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: 0, start_delay: 0 },
    });

    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    const teamRow = table.locator("tr.team-row").filter({ hasText: "서울대학교" });
    await expect(teamRow).toBeVisible();

    // With penalty=0, best is B=4000ms → "04.000"
    await expect(async () => {
      const text = await teamRow.textContent();
      expect(text).toContain("04.000");
    }).toPass({ timeout: 10000 });

    // Change cone_penalty=2: B adjusted = 4000 + 3*2*1000 = 10000 > A=5000
    // Best becomes A=5000ms → "05.000"
    await page.request.put("/score/api/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 2, oc_penalty: 0, start_delay: 0 },
    });

    await expect(async () => {
      const text = await teamRow.textContent();
      expect(text).toContain("05.000");
    }).toPass({ timeout: 10000 });
  });
});
