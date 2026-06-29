import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Inspection gate (inspection/index.mjs authRoleFn ~lines 109-115):
//   /api/sheet/template* with method != GET  -> "chief"
//   everything else under /api/ (and SPA)    -> "official"
// official sits one level below chief -> expect 403 on template writes.
// official is NOT gated out of /api/sheet/answer (it requires "official"), so any
// non-403 status proves the answer route is reachable for official.
// Unauthenticated -> 401 on any gated /api/ path.

// chief-gated template writes
const chiefTemplateWrites = [
  { method: "post", path: "/inspection/api/sheet/template", body: { year: new Date().getFullYear(), level: "category", name: `rbac-${Date.now()}` } },
  { method: "put", path: "/inspection/api/sheet/template/999999", body: { name: `rbac-${Date.now()}` } },
  { method: "delete", path: "/inspection/api/sheet/template/999999", body: {} },
  { method: "post", path: "/inspection/api/sheet/template/reorder", body: { ids: [] } },
];

test.describe("inspection RBAC", () => {
  for (const { method, path, body } of chiefTemplateWrites) {
    test(`official is rejected (403) on ${method.toUpperCase()} ${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: storageStatePath("official") });
      const res = await ctx.request[method](path, { data: body });
      expect(res.status()).toBe(403);
      await ctx.close();
    });

    test(`unauthenticated is rejected (401) on ${method.toUpperCase()} ${path}`, async ({ request }) => {
      const res = await request[method](path, { data: body });
      expect(res.status()).toBe(401);
    });
  }

  test("official is NOT gated out of PUT /inspection/api/sheet/answer (not 403)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("official") });
    // Benign payload; the answer route is "official"-gated, so the only thing this
    // asserts is that RBAC does not reject it. The body may be rejected on validation,
    // which is fine — any non-403 status proves official is permitted past the gate.
    const res = await ctx.request.put("/inspection/api/sheet/answer", {
      data: { year: new Date().getFullYear(), num: 999999, item_id: 999999, value: "rbac" },
    });
    expect(res.status()).not.toBe(403);
    await ctx.close();
  });

  test("unauthenticated is rejected (401) on PUT /inspection/api/sheet/answer", async ({ request }) => {
    const res = await request.put("/inspection/api/sheet/answer", {
      data: { year: new Date().getFullYear(), num: 999999, item_id: 999999, value: "rbac" },
    });
    expect(res.status()).toBe(401);
  });
});
