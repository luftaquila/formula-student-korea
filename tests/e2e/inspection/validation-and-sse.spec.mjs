import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Inspection value-checked save and SSE semantics", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("keeps audit metadata on an identical save and broadcasts a changed memo", async ({ page }) => {
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    expect(templateRes.status()).toBe(200);
    const template = await templateRes.json();
    const item = template.find((category) => category.name === "전기 검차")
      ?.subcategories?.[0]?.groups?.[0]?.items?.find((candidate) => candidate.name === "절연 저항 측정");
    expect(item?.id).toBeTruthy();

    const team = 7;
    const initialDataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${team}`);
    expect(initialDataRes.status()).toBe(200);
    const initialRecord = (await initialDataRes.json()).answers[item.id] || {};
    const initialValue = initialRecord.value || "";
    const initialMemo = initialRecord.memo || "";
    const seedValue = `${1000 + (Date.now() % 1000)}`;
    const memo = `E2E-MEMO-${Date.now()}`;
    try {
      const first = await page.request.put("/competition/api/v1/inspection/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: seedValue, expectedValue: initialValue },
      });
      expect(first.status()).toBe(200);
      const firstBody = await first.json();

      const sse = page.waitForResponse((response) => response.url().includes("/competition/api/v1/inspection/sheet/events"));
      await page.goto(`/inspection/${YEAR}/${team}`);
      await waitForPageReady(page);
      await sse;
      const row = page.locator(".item-row").filter({ hasText: "절연 저항 측정" });
      const numberInput = row.locator('input[type="number"]');
      await expect(numberInput).toHaveValue(seedValue, { timeout: 10000 });

      const identical = await page.request.put("/competition/api/v1/inspection/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: seedValue, expectedValue: seedValue },
      });
      expect(identical.status()).toBe(200);
      const identicalBody = await identical.json();
      expect(identicalBody.version).toBeUndefined();
      expect(identicalBody.updated_at).toBe(firstBody.updated_at);

      const memoPut = await page.request.put("/competition/api/v1/inspection/sheet/memo", {
        data: { year: YEAR, team_num: team, item_id: item.id, memo, expectedMemo: initialMemo },
      });
      expect(memoPut.status()).toBe(200);
      await expect(row.locator(".memo-text")).toContainText(memo, { timeout: 10000 });
      await expect(numberInput).toHaveValue(seedValue);
    } finally {
      await page.request.put("/competition/api/v1/inspection/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: initialValue, expectedValue: seedValue },
      });
      await page.request.put("/competition/api/v1/inspection/sheet/memo", {
        data: { year: YEAR, team_num: team, item_id: item.id, memo: initialMemo, expectedMemo: memo },
      });
    }
  });
});
