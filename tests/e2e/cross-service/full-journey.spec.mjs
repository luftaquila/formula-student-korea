import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { completeInspectionCategory, restoreInspectionAnswers } from "../helpers/inspection.mjs";

const YEAR = currentCompetitionYear();
const INSPECTION_TYPE = "noise";
const TEAM_NUM = 32;

async function apiRegister(num) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/register/${INSPECTION_TYPE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiEnterBooth(num, boothNum = 1) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${INSPECTION_TYPE}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(boothNum = 1) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${INSPECTION_TYPE}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
  });
}

async function apiGetQueue() {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/inspection/${INSPECTION_TYPE}`, {
    headers: { Cookie: getAuthCookie("operationsOperator") },
  });
  return res.json();
}

async function cleanupQueue() {
  await apiExitBooth(1).catch(() => {});
  const queue = await apiGetQueue();
  for (const item of queue) {
    await apiEnterBooth(item.num, 1).catch(() => {});
    await apiExitBooth(1).catch(() => {});
  }
}

test.describe("Full journey: Queue -> Inspection -> Score", () => {
  test.use({ storageState: storageStatePath("admin") });

  let originalPenalty;
  let categoryId;
  let category;
  let completionChanges = [];

  test.beforeAll(async () => {
    // Save cancel penalty
    const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("operationsManager") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ value: 0 }),
    });

    // Get category ID by name
    const templateRes = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/template?year=${YEAR}`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const template = await templateRes.json();
    category = template.find((c) => c.name === "전기 검차");
    categoryId = category.id;
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test.afterEach(async () => {
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };

    // Clear category result and restore answers for this spec's team.
    await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ year: YEAR, team_num: TEAM_NUM, category_id: categoryId, result: "" }),
    });
    await restoreInspectionAnswers({
      year: YEAR,
      teamNum: TEAM_NUM,
      changes: completionChanges,
      role: "admin",
    });
    completionChanges = [];

    // Cleanup queue
    await cleanupQueue();
  });

  test("queue registration flows through inspection to score dashboard", async ({ page }) => {
    // Step 1: Register this spec's team into the noise queue.
    const regRes = await apiRegister(TEAM_NUM);
    expect(regRes.status).toBe(201);

    // Step 2: Enter booth
    const enterRes = await apiEnterBooth(TEAM_NUM);
    expect(enterRes.status).toBe(200);

    // Step 3: Exit booth (complete inspection queue step)
    const exitRes = await apiExitBooth();
    expect(exitRes.status).toBe(200);

    // Step 4: Complete the category and set its result to PASS.
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };
    completionChanges = await completeInspectionCategory({
      year: YEAR,
      teamNum: TEAM_NUM,
      category,
      role: "admin",
    });
    const setResultRes = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ year: YEAR, team_num: TEAM_NUM, category_id: categoryId, result: "PASS" }),
    });
    expect(setResultRes.status).toBe(200);

    // Step 5: Open score dashboard and verify the inspection result propagates
    await page.goto("/score");
    await waitForPageReady(page);

    const table = scoreTable(page);
    await expect(table).toBeVisible({ timeout: 10000 });

    // Enable inspection columns if hidden
    const inspectionCheckbox = page.locator(".filter-bar").locator("label.filter-checkbox").filter({ hasText: "검차" }).locator("input[type='checkbox']");
    if (!(await inspectionCheckbox.isChecked())) {
      await inspectionCheckbox.check();
    }

    // Verify this spec's team shows a PASS badge for 전기 검차.
    const teamRow = table.locator("tr.team-row").filter({ hasText: "중앙대학교" });
    await expect(teamRow).toBeVisible();
    await expect(async () => {
      const badge = teamRow.locator(".badge-success");
      await expect(badge).toContainText("PASS");
    }).toPass({ timeout: 10000 });
  });
});
