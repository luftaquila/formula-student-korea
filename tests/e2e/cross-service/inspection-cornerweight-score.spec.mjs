import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Corner-weight (코너웨이트) propagation, inspection → score:
// score.computeScore() discovers a category literally named "코너웨이트" whose
// items are 공차중량/FL/FR/RL/RR, bulk-fetches their answers, and exposes them as
// inspection.cornerWeight.teams[num]. The score frontend renders the 공차중량 value
// in the corner-weight column and, crucially, updates it live from the
// `inspection:answer` SSE event that score RE-BROADCASTS off the inspection
// service's `answer` event (score/index.mjs createSSESubscriber, allow-list
// {category-result, answer}; ScoreBoard.vue lastAnswerUpdate watcher).
//
// The seeded template (seed.mjs) has NO 코너웨이트 category, so we ADD one for the
// current year, scoped to an isolated team. To avoid disturbing other specs that
// assert the seeded category ORDER (e.g. inspection sheet-fill / template-roundtrip
// expect 전기 검차 / 샤시 검차 at indices 0/1), we append the category with a high
// sort_order (it sorts last) and DELETE it again in afterAll (CASCADE drops its
// items + answers). cross-service runs after the inspection project completes, so
// the temporary category cannot race those already-finished specs.

const YEAR = new Date().getFullYear();
const STAMP = Date.now();
const NUM = (STAMP % 100000) + 800; // isolated, outside seeded 1..32
const UNIV = `코너웨이트대-${STAMP}`;
const TEAM = `CornerWeight ${STAMP}`;
const SEED_CURB = 210; // initial 공차중량 (kg)
const NEW_CURB = 222; // updated 공차중량 (kg)

test.describe("Inspection corner-weight answer propagates to score dashboard", () => {
  test.use({ storageState: storageStatePath("admin") });

  const adminHeaders = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };
  const chiefHeaders = { "Content-Type": "application/json", Cookie: getAuthCookie("chief") };

  // Template node IDs created in beforeAll.
  let categoryId;
  const itemIds = {}; // { 공차중량, FL, FR, RL, RR }

  async function createNode(body) {
    const res = await fetch(`${BASE_URL}/inspection/api/sheet/template`, {
      method: "POST",
      headers: chiefHeaders, // template writes require chief+
      body: JSON.stringify({ year: YEAR, ...body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).id;
  }

  async function putAnswer(itemId, value) {
    return fetch(`${BASE_URL}/inspection/api/sheet/answer`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ year: YEAR, team_num: NUM, item_id: itemId, value: String(value) }),
    });
  }

  test.beforeAll(async () => {
    // Isolated entry so the team renders as a row on the score dashboard.
    const entryRes = await fetch(`${BASE_URL}/entry/api/entries?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ num: NUM, univ: UNIV, team: TEAM }),
    });
    expect(entryRes.status).toBe(201);

    // Build the 4-level hierarchy: 코너웨이트 category → subcategory → group → 5 items.
    // High sort_order keeps the category last so it never displaces 전기/샤시 검차.
    categoryId = await createNode({ level: "category", name: "코너웨이트", sort_order: 9999 });
    const subId = await createNode({ level: "subcategory", parent_id: categoryId, name: "무게", sort_order: 0 });
    const groupId = await createNode({ level: "group", parent_id: subId, name: "코너별 무게", sort_order: 0 });

    // computeScore requires all 5 names present for cornerWeight to be non-null.
    const itemNames = ["공차중량", "FL", "FR", "RL", "RR"];
    for (let i = 0; i < itemNames.length; i++) {
      itemIds[itemNames[i]] = await createNode({
        level: "item",
        parent_id: groupId,
        name: itemNames[i],
        sort_order: i,
        answer_type: "number",
        unit: "kg",
      });
    }

    // Seed all 5 answers so score's bulk-answers fetch populates cornerWeight.teams[NUM].
    expect((await putAnswer(itemIds["공차중량"], SEED_CURB)).status).toBe(200);
    expect((await putAnswer(itemIds["FL"], 50)).status).toBe(200);
    expect((await putAnswer(itemIds["FR"], 52)).status).toBe(200);
    expect((await putAnswer(itemIds["RL"], 54)).status).toBe(200);
    expect((await putAnswer(itemIds["RR"], 56)).status).toBe(200);
  });

  test.afterAll(async () => {
    // CASCADE: deleting the category removes its subcats/groups/items and their answers.
    if (categoryId) {
      try {
        await fetch(`${BASE_URL}/inspection/api/sheet/template/${categoryId}`, {
          method: "DELETE",
          headers: chiefHeaders,
        });
      } catch { /* ignore */ }
    }
    try {
      await fetch(`${BASE_URL}/entry/api/entries/${NUM}?year=${YEAR}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
    } catch { /* ignore */ }
  });

  test("score corner-weight cell reflects an inspection:answer change via SSE", async ({ page }) => {
    // Confirm score's aggregation actually exposes our seeded corner-weight first
    // (this is the inspection → score bulk-answers join that the dashboard renders).
    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/score/api/score?year=${YEAR}`, { headers: adminHeaders });
      if (res.status !== 200) return null;
      const data = await res.json();
      const cw = data.inspection?.cornerWeight;
      if (!cw || cw.categoryId !== categoryId) return null;
      return cw.teams?.[NUM]?.curb;
    }, { timeout: 10000 }).toBe(String(SEED_CURB));

    // Open the score dashboard.
    await page.goto("/score");
    await waitForPageReady(page);

    const table = page.locator("table.score-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Ensure inspection columns are shown (default on, but be explicit).
    const inspectionCheckbox = page.locator(".filter-bar")
      .locator("label.filter-checkbox").filter({ hasText: "검차" })
      .locator("input[type='checkbox']");
    if (!(await inspectionCheckbox.isChecked())) {
      await inspectionCheckbox.check();
    }

    // Our isolated team row + its corner-weight cell.
    const teamRow = table.locator("tr.team-row").filter({ hasText: UNIV });
    await expect(teamRow).toBeVisible({ timeout: 10000 });
    const cwCell = teamRow.locator("td.col-corner-weight .cw-value");

    // Initial 공차중량 is rendered (loaded via the score aggregation above).
    await expect(cwCell).toContainText(`${SEED_CURB} kg`, { timeout: 10000 });

    // Change 공차중량 via the inspection API. inspection broadcasts `answer`, score
    // re-broadcasts `inspection:answer`, and the dashboard's lastAnswerUpdate watcher
    // mutates cornerWeight.teams[NUM].curb — no full refetch needed.
    const updRes = await putAnswer(itemIds["공차중량"], NEW_CURB);
    expect(updRes.status).toBe(200);

    // The cell updates live from the re-broadcast SSE event (client-only mutation →
    // Playwright auto-retry assertion).
    await expect(cwCell).toContainText(`${NEW_CURB} kg`, { timeout: 10000 });
    await expect(cwCell).not.toContainText(`${SEED_CURB} kg`);
  });
});
