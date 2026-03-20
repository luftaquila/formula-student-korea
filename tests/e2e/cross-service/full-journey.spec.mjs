import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = new Date().getFullYear();
const INSPECTION_TYPE = "noise";

async function apiRegister(num) {
  return fetch(`${BASE_URL}/queue/api/admin/register/${INSPECTION_TYPE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

async function apiEnterBooth(num, boothNum = 1) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(boothNum = 1) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${INSPECTION_TYPE}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiGetQueue() {
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${INSPECTION_TYPE}`, {
    headers: { Cookie: getAuthCookie("official") },
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

  test.beforeAll(async () => {
    // Save cancel penalty
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });

    // Get category ID by name
    const templateRes = await fetch(`${BASE_URL}/inspection/api/sheet/template?year=${YEAR}`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const template = await templateRes.json();
    const category = template.find((c) => c.name === "전기 검차");
    categoryId = category.id;
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test.afterEach(async () => {
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };

    // Clear category result for team 30
    await fetch(`${BASE_URL}/inspection/api/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ year: YEAR, team_num: 30, category_id: categoryId, result: "" }),
    });

    // Cleanup queue
    await cleanupQueue();
  });

  test("queue registration flows through inspection to score dashboard", async ({ page }) => {
    // Step 1: Register team 30 into noise queue
    const regRes = await apiRegister(30);
    expect(regRes.status).toBe(201);

    // Step 2: Enter booth
    const enterRes = await apiEnterBooth(30);
    expect(enterRes.status).toBe(200);

    // Step 3: Exit booth (complete inspection queue step)
    const exitRes = await apiExitBooth();
    expect(exitRes.status).toBe(200);

    // Step 4: Set category result to PASS for team 30
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };
    const setResultRes = await fetch(`${BASE_URL}/inspection/api/sheet/category-result`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ year: YEAR, team_num: 30, category_id: categoryId, result: "PASS" }),
    });
    expect(setResultRes.status).toBe(200);

    // Step 5: Open score dashboard and verify the inspection result propagates
    await page.goto("/score");
    await waitForPageReady(page);

    const table = page.locator("table.score-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Enable inspection columns if hidden
    const inspectionCheckbox = page.locator(".filter-bar").locator("label.filter-checkbox").filter({ hasText: "검차" }).locator("input[type='checkbox']");
    if (!(await inspectionCheckbox.isChecked())) {
      await inspectionCheckbox.check();
    }

    // Verify team 30 shows PASS badge for 전기 검차
    const teamRow = table.locator("tr.team-row").filter({ hasText: "부산대학교" });
    await expect(teamRow).toBeVisible();
    await expect(async () => {
      const badge = teamRow.locator(".badge-success");
      await expect(badge).toContainText("PASS");
    }).toPass({ timeout: 10000 });
  });
});
