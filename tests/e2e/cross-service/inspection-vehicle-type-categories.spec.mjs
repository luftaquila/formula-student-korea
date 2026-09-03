import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, SCORE_TABLE, scoreTable } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Per-vehicle-type category visibility, end to end across inspection + entry + score:
// a category carries excluded_types (vehicle type NAMES, stored as exclusions so a newly
// added type defaults to visible). The template management UI writes it via one checkbox
// per type; the team sheet drops the tab entirely for a team of an excluded type; the team
// list and the score dashboard keep the shared column but leave that team's cell blank.
//
// Vehicle types live in the canonical yearly roster while exclusions live in
// Inspection, so this spans two Competition modules without copying the roster.
//
// The seeded inspection template has exactly 2 categories and inspection specs assert that
// count (sheet-fill expects 2 tabs, template-roundtrip expects 2 exported), so the
// temporary category is created HERE — cross-service runs after the inspection project
// finishes — with a high sort_order, and is deleted in afterAll (CASCADE).

const YEAR = currentCompetitionYear();
const STAMP = Date.now();
const CAT_NAME = `유형필터-${STAMP}`;

// Seeded entries: #1 서울대학교 is EV, #3 성균관대학교 is CV. The category below excludes CV.
const EV_TEAM = { num: 1, univ: "서울대학교" };
const CV_TEAM = { num: 3, univ: "성균관대학교" };

test.describe("Per-vehicle-type inspection category visibility", () => {
  test.use({ storageState: storageStatePath("admin") });

  const managerHeaders = { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") };
  const officialHeaders = { Cookie: getAuthCookie("operationsOperator") };

  let categoryId;

  async function fetchCategory() {
    const res = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/template?year=${YEAR}`, { headers: officialHeaders });
    expect(res.status).toBe(200);
    return (await res.json()).find(c => c.id === categoryId);
  }

  async function putExcludedTypes(types) {
    const res = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/template/${categoryId}`, {
      method: "PUT",
      headers: managerHeaders, // template writes require inspection.manage
      body: JSON.stringify({ excluded_types: types }),
    });
    expect(res.status).toBe(200);
  }

  function typeToggle(page, typeName) {
    return page.locator(".type-visibility-row label.type-toggle")
      .filter({ hasText: typeName })
      .locator("input[type='checkbox']");
  }

  async function openCategoryTab(page) {
    await page.goto("/inspection/template");
    await waitForPageReady(page);
    await page.locator(".tabs .tab").filter({ hasText: CAT_NAME }).click();
  }

  // Columns come and go while parallel cross-service specs mutate templates, so
  // the header index, the header/body alignment, and the cell text are read in ONE poll
  // attempt rather than captured across separate awaits.
  function readCategoryCell(page, tableSelector, rowSelector, univ) {
    return async () => {
      const headers = await page.locator(`${tableSelector} thead th`).allInnerTexts();
      const idx = headers.findIndex(t => t.trim().startsWith(CAT_NAME));
      if (idx === -1) return "column-missing";
      const row = page.locator(`${tableSelector} tbody ${rowSelector}`).filter({ hasText: univ });
      if (await row.count() !== 1) return "row-missing";
      const cells = row.locator("td");
      if (await cells.count() !== headers.length) return "header-body-misaligned";
      return (await cells.nth(idx).innerText()).trim();
    };
  }

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/template`, {
      method: "POST",
      headers: managerHeaders,
      body: JSON.stringify({
        year: YEAR,
        level: "category",
        name: CAT_NAME,
        sort_order: 9998,
        excluded_types: ["CV"],
      }),
    });
    expect(res.status).toBe(200);
    categoryId = (await res.json()).id;
  });

  test.afterAll(async () => {
    if (!categoryId) return;
    try {
      await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/template/${categoryId}`, {
        method: "DELETE",
        headers: managerHeaders,
      });
    } catch { /* ignore */ }
  });

  test("template management checkboxes reflect and update the stored exclusions", async ({ page }) => {
    await putExcludedTypes(["CV"]); // 재시도해도 같은 상태에서 시작하도록 사전 상태를 고정한다.
    await openCategoryTab(page);

    // Exclusions are stored, not inclusions — an untouched type stays checked.
    await expect(typeToggle(page, "EV")).toBeChecked();
    await expect(typeToggle(page, "CV")).not.toBeChecked();

    // Checking clears the exclusion. The PUT fires immediately (no debounce), so arm the
    // wait before the click.
    let saved = page.waitForResponse(res =>
      res.url().includes(`/competition/api/v1/inspection/sheet/template/${categoryId}`) &&
      res.request().method() === "PUT" && res.status() === 200);
    await typeToggle(page, "CV").check();
    await saved;
    expect((await fetchCategory()).excluded_types).toEqual([]);

    // Unchecking stores it again — this also restores the precondition for the tests below.
    saved = page.waitForResponse(res =>
      res.url().includes(`/competition/api/v1/inspection/sheet/template/${categoryId}`) &&
      res.request().method() === "PUT" && res.status() === 200);
    await typeToggle(page, "CV").uncheck();
    await saved;
    expect((await fetchCategory()).excluded_types).toEqual(["CV"]);

    // Reload to prove the checkbox renders from the stored value, not from local state.
    await openCategoryTab(page);
    await expect(typeToggle(page, "CV")).not.toBeChecked();
    await expect(typeToggle(page, "EV")).toBeChecked();
  });

  test("the team sheet drops the tab for an excluded type and keeps it otherwise", async ({ page }) => {
    await page.goto(`/inspection/${YEAR}/${CV_TEAM.num}`);
    await waitForPageReady(page);
    // The seeded categories stay put — only the excluded one disappears.
    await expect(page.locator(".tabs .tab").filter({ hasText: "전기 검차" })).toHaveCount(1);
    await expect(page.locator(".tabs .tab").filter({ hasText: CAT_NAME })).toHaveCount(0);

    await page.goto(`/inspection/${YEAR}/${EV_TEAM.num}`);
    await waitForPageReady(page);
    await expect(page.locator(".tabs .tab").filter({ hasText: CAT_NAME })).toHaveCount(1);
  });

  test("the team list keeps the column but blanks the excluded team's cell", async ({ page }) => {
    await page.goto("/inspection");
    await waitForPageReady(page);
    await expect(page.locator(".sheet-table")).toBeVisible({ timeout: 10000 });

    // Excluded → nothing at all, not even the "-" placeholder.
    await expect.poll(
      readCategoryCell(page, ".sheet-table", "tr.clickable-row", CV_TEAM.univ),
      { timeout: 10000 },
    ).toBe("");

    // Included → the usual empty-result placeholder, since no PASS/FAIL was recorded.
    await expect.poll(
      readCategoryCell(page, ".sheet-table", "tr.clickable-row", EV_TEAM.univ),
      { timeout: 10000 },
    ).toBe("-");
  });

  test("the score dashboard blanks the excluded team's inspection cell", async ({ page }) => {
    await page.goto("/score");
    await waitForPageReady(page);
    await expect(scoreTable(page)).toBeVisible({ timeout: 10000 });

    // Inspection columns are on by default, but be explicit — they are v-show'd, and a
    // hidden th reports empty innerText, which would break the column lookup.
    const inspectionCheckbox = page.locator(".filter-bar")
      .locator("label.filter-checkbox").filter({ hasText: "검차" })
      .locator("input[type='checkbox']");
    if (!(await inspectionCheckbox.isChecked())) {
      await inspectionCheckbox.check();
    }

    await expect.poll(
      readCategoryCell(page, SCORE_TABLE, "tr.team-row", CV_TEAM.univ),
      { timeout: 15000 },
    ).toBe("");

    await expect.poll(
      readCategoryCell(page, SCORE_TABLE, "tr.team-row", EV_TEAM.univ),
      { timeout: 15000 },
    ).toBe("-");
  });
});
