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
    const statusButton = page.getByRole("button", { name: /규정 연결 편집/ }).first();
    await statusButton.click();
    const dialog = page.getByRole("dialog", { name: "규정 연결" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: /제10조 9항/ }).check();
    await page.getByRole("button", { name: "선택 규정 저장" }).click();
    await expect.poll(() => savedBody).toEqual({
      expected_rule_refs: { status: "needs_review", references: [] },
      status: "verified",
      rule_keys: ["formula-technical.brake-light"],
    });
    await expect(statusButton).toHaveText("규정 1");
    await context.close();
  });

  test("discards a stale rule selection and adopts the winning value", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.route("**/competition/api/v1/inspection/sheet/template?year=*", async route => {
      const response = await route.fetch();
      const template = await response.json();
      const first = template[0].subcategories[0].groups[0].items[0];
      first.rule_refs = { status: "no_direct_rule", references: [] };
      await route.fulfill({ response, json: template });
    });
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
    const winningRuleRefs = {
      status: "verified",
      references: [reference("formula-technical.grounding", "formula-technical-48", "제48조")],
    };
    let savedBody;
    await page.route(/\/competition\/api\/v1\/inspection\/sheet\/template\/\d+\/rule-refs$/, async route => {
      savedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "INSPECTION_STALE_WRITE",
          message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요.",
          current: { rule_refs: winningRuleRefs },
        }),
      });
    });

    await page.goto("/inspection/template");
    await waitForPageReady(page);
    const statusButton = page.getByRole("button", { name: /규정 연결 편집/ }).first();
    await statusButton.click();
    const dialog = page.getByRole("dialog", { name: "규정 연결" });
    await dialog.getByRole("checkbox", { name: /제10조 9항/ }).check();
    await page.getByRole("button", { name: "선택 규정 저장" }).click();

    await expect.poll(() => savedBody).toEqual({
      expected_rule_refs: { status: "no_direct_rule", references: [] },
      status: "verified",
      rule_keys: ["formula-technical.brake-light"],
    });
    await expect(dialog).toBeHidden();
    await expect(statusButton).toHaveText("규정 1");
    await context.close();
  });

  test("renders verified, review, hidden, multiple, and print states", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.route(/\/competition\/api\/v1\/inspection\/sheet\/rule-content\/\d+$/, route => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rules: [
            {
              ...reference("formula-technical.brake-light", "formula-technical-10-9", "제10조 9항"),
              reference_index: 0,
              content_html: `<p onclick="window.__rulePopoverAttack = true">제동등을 장착해야 한다.</p>
                <script>window.__rulePopoverAttack = true</script>
                <a href="javascript:window.__rulePopoverAttack = true">위험 URL</a>
                <img src="bad" onerror="window.__rulePopoverAttack = true" alt="회로도">
                <svg onload="window.__rulePopoverAttack = true"><script>window.__rulePopoverAttack = true</script></svg>
                <math><mrow onmouseover="window.__rulePopoverAttack = true"><mi href="javascript:bad">V</mi></mrow></math>`,
            },
            {
              ...reference("formula-technical.grounding", "formula-technical-48", "제48조"),
              reference_index: 1,
              content_html: "<p>차량은 접지 기준을 충족해야 한다.</p>",
            },
          ],
        }),
      });
    });
    let ruleItemNames = [];
    await page.route("**/competition/api/v1/inspection/sheet/template?year=*", async route => {
      const response = await route.fetch();
      const template = await response.json();
      const items = template.flatMap(category => category.subcategories.flatMap(subcategory =>
        subcategory.groups.flatMap(group => group.items)));
      ruleItemNames = items.slice(0, 3).map(item => item.name);
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
    const ruleButton = page.getByRole("button", { name: `${ruleItemNames[0]} 대응 규정 보기` });
    await ruleButton.focus();
    await ruleButton.press("Enter");
    await expect(ruleButton).toHaveAttribute("aria-expanded", "true");
    const rulePopover = page.getByRole("dialog", { name: `${ruleItemNames[0]} 대응 규정` });
    await expect(rulePopover).toContainText("제동등을 장착해야 한다.");
    await expect(rulePopover.getByRole("article")).toHaveCount(2);
    await expect(rulePopover.getByRole("link", { name: "원문" })).toHaveCount(2);
    await expect(rulePopover.getByRole("link", { name: "원문" }).first()).toHaveAttribute("target", "_blank");
    const source = rulePopover.getByRole("document", { name: "제10조 9항 규정 원문" });
    await expect(source).toContainText("위험 URL");
    await expect(source).toContainText("회로도");
    await expect(source.locator("script, svg, img, [onclick], [onerror], [onload], [onmouseover], [href]")).toHaveCount(0);
    expect(await page.evaluate(() => window.__rulePopoverAttack)).toBeUndefined();
    await expect(page.getByRole("button", { name: `${ruleItemNames[1]} 규정 연결 검토 필요` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `${ruleItemNames[2]} 대응 규정 보기` })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(rulePopover).toBeHidden();
    await expect(ruleButton).toHaveAttribute("aria-expanded", "false");
    await expect(ruleButton).toBeFocused();

    await page.goto(`/inspection/template/print?year=${YEAR}`);
    await expect(page.locator("body")).toContainText("차량기술규정 제10조 9항 · 차량기술규정 제48조");
    await expect(page.locator("body")).not.toContainText("규정 연결 검토 필요");
    await context.close();
  });
});
