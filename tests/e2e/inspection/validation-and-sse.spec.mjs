import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Inspection no-op save and SSE semantics", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("keeps the answer version on an identical save and broadcasts a changed memo", async ({ page }) => {
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    expect(templateRes.status()).toBe(200);
    const template = await templateRes.json();
    const item = template.find((category) => category.name === "전기 검차")
      ?.subcategories?.[0]?.groups?.[0]?.items?.find((candidate) => candidate.name === "절연 저항 측정");
    expect(item?.id).toBeTruthy();

    const team = 7;
    const seedValue = `${1000 + (Date.now() % 1000)}`;
    try {
      const first = await page.request.put("/inspection/api/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: seedValue },
      });
      expect(first.status()).toBe(200);
      const firstBody = await first.json();

      const sse = page.waitForResponse((response) => response.url().includes("/api/sheet/events"));
      await page.goto(`/inspection/${YEAR}/${team}`);
      await waitForPageReady(page);
      await sse;
      const row = page.locator(".item-row").filter({ hasText: "절연 저항 측정" });
      const numberInput = row.locator('input[type="number"]');
      await expect(numberInput).toHaveValue(seedValue, { timeout: 10000 });

      const identical = await page.request.put("/inspection/api/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: seedValue },
      });
      expect(identical.status()).toBe(200);
      const identicalBody = await identical.json();
      expect(identicalBody.version).toBe(firstBody.version);
      expect(identicalBody.updated_at).toBe(firstBody.updated_at);

      const memo = `E2E-MEMO-${Date.now()}`;
      const memoPut = await page.request.put("/inspection/api/sheet/memo", {
        data: { year: YEAR, team_num: team, item_id: item.id, memo },
      });
      expect(memoPut.status()).toBe(200);
      await expect(row.locator(".memo-text")).toContainText(memo, { timeout: 10000 });
      await expect(numberInput).toHaveValue(seedValue);
    } finally {
      await page.request.put("/inspection/api/sheet/answer", {
        data: { year: YEAR, team_num: team, item_id: item.id, value: "" },
      });
      await page.request.put("/inspection/api/sheet/memo", {
        data: { year: YEAR, team_num: team, item_id: item.id, memo: "" },
      });
    }
  });
});
