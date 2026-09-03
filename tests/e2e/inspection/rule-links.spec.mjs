import { test, expect } from "@playwright/test";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const HASH = `sha256:${"a".repeat(64)}`;

function reference(ruleKey, clauseId, citation) {
  return {
    edition: YEAR,
    document: "formula-technical",
    rule_key: ruleKey,
    clause_id: clauseId,
    citation,
    source_hash: HASH,
  };
}

test.describe("Inspection rule reference UI", () => {
  test("lets a template manager search and attach stable-keyed clauses", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.route("**/competition/api/v1/inspection/sheet/rules/search?*", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        year: YEAR,
        rules: [{
          ...reference("formula-technical.brake-light", "formula-technical-10-9", "제10조 9항"),
          text: "제동등을 장착해야 한다.",
          content_hash: HASH,
        }],
      }),
    }));
    let savedBody;
    await page.route(/\/competition\/api\/v1\/inspection\/sheet\/template\/\d+\/rule-refs$/, async route => {
      savedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "verified",
          references: [reference("formula-technical.brake-light", "formula-technical-10-9", "제10조 9항")],
        }),
      });
    });

    await page.goto("/inspection/template");
    await waitForPageReady(page);
    await page.locator(".rule-status-btn").first().click();
    await expect(page.locator(".rule-dialog")).toBeVisible();
    await expect(page.locator(".rule-result")).toContainText("제10조 9항");
    await page.locator(".rule-result input").check();
    await page.getByRole("button", { name: "선택 규정 저장" }).click();
    await expect.poll(() => savedBody).toEqual({
      status: "verified",
      rule_keys: ["formula-technical.brake-light"],
    });
    await expect(page.locator(".rule-status-btn").first()).toContainText("규정 1");
    await context.close();
  });

  test("renders verified, review, hidden, multiple, and print states", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.route("**/competition/api/v1/inspection/sheet/template?year=*", async route => {
      const response = await route.fetch();
      const template = await response.json();
      const items = template.flatMap(category => category.subcategories.flatMap(subcategory =>
        subcategory.groups.flatMap(group => group.items)));
      items[0].rule_refs = {
        status: "verified",
        references: [
          reference("formula-technical.brake-light", "formula-technical-10-9", "제10조 9항"),
          reference("formula-technical.grounding", "formula-technical-48", "제48조"),
        ],
      };
      items[1].rule_refs = { status: "needs_review", references: [] };
      items[2].rule_refs = { status: "no_direct_rule", references: [] };
      await route.fulfill({ response, json: template });
    });

    await page.goto(`/inspection/${YEAR}/1`);
    await waitForPageReady(page);
    const rows = page.locator(".item-row");
    await rows.nth(0).locator(".rule-help-menu summary").click();
    await expect(rows.nth(0).locator(".rule-help-options a")).toHaveCount(2);
    await expect(rows.nth(0).locator(".rule-help-options a").first()).toHaveAttribute("target", "_blank");
    await expect(rows.nth(1).locator(".rule-help-button.needs-review")).toBeDisabled();
    await expect(rows.nth(2).locator(".rule-help-button")).toHaveCount(0);

    await page.goto(`/inspection/template/print?year=${YEAR}`);
    await expect(page.locator("body")).toContainText("기술 제10조 9항 · 기술 제48조");
    await expect(page.locator("body")).not.toContainText("규정 연결 검토 필요");
    await context.close();
  });
});
