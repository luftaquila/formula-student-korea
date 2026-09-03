import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Inspection gate (inspection/index.mjs authRoleFn ~lines 109-115):
//   /api/sheet/template* with method != GET  -> inspection.manage
//   operational sheet APIs                  -> inspection.operate
// An operator has no template-management permission, so writes return 403.
// /api/sheet/answer requires official and a valid seeded item.
// Unauthenticated -> 401 on any gated /api/ path.

// inspection.manage template writes
const chiefTemplateWrites = [
  { method: "post", path: "/competition/api/v1/inspection/sheet/template", body: { year: currentCompetitionYear(), level: "category", name: `rbac-${Date.now()}` } },
  { method: "put", path: "/competition/api/v1/inspection/sheet/template/999999", body: { name: `rbac-${Date.now()}` } },
  { method: "delete", path: "/competition/api/v1/inspection/sheet/template/999999", body: {} },
  { method: "post", path: "/competition/api/v1/inspection/sheet/template/reorder", body: { ids: [] } },
];

test.describe("inspection RBAC", () => {
  test("official is rejected on every representative template write", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    try {
      for (const { method, path, body } of chiefTemplateWrites) {
        await test.step(`${method.toUpperCase()} ${path}`, async () => {
          const res = await ctx.request[method](path, { data: body });
          expect(res.status()).toBe(403);
        });
      }
    } finally {
      await ctx.close();
    }
  });

  test("unauthenticated callers are rejected on template and answer writes", async ({ request }) => {
    for (const { method, path, body } of chiefTemplateWrites) {
      await test.step(`${method.toUpperCase()} ${path}`, async () => {
        const res = await request[method](path, { data: body });
        expect(res.status()).toBe(401);
      });
    }
    const answer = await request.put("/competition/api/v1/inspection/sheet/answer", {
      data: { year: currentCompetitionYear(), team_num: 98, item_id: 999999, value: "" },
    });
    expect(answer.status()).toBe(401);
  });

  test("official can save an answer through the deployed route", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    try {
      const year = currentCompetitionYear();
      const templateRes = await ctx.request.get(`/competition/api/v1/inspection/sheet/template?year=${year}`);
      expect(templateRes.status()).toBe(200);
      const template = await templateRes.json();
      const item = template[0]?.subcategories?.[0]?.groups?.[0]?.items?.[0];
      expect(item?.id).toBeTruthy();
      const res = await ctx.request.put("/competition/api/v1/inspection/sheet/answer", {
        data: { year, team_num: 98, item_id: item.id, value: "" },
      });
      expect(res.status()).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
