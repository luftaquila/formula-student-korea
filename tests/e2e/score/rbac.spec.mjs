import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Score gate (score/index.mjs authRoleFn ~lines 104-107):
//   /api/health -> public; EVERYTHING else -> "admin".
// chief sits one level below admin -> expect 403 on every protected route,
// including the GET /api/score read (it is admin-gated, not public).
// Unauthenticated -> 401.

const adminGated = [
  { method: "get", path: "/score/api/score", body: undefined },
  { method: "put", path: "/score/api/score/manual", body: { num: 999999, event: "rbac", value: 0 } },
  { method: "put", path: "/score/api/score/penalty", body: { num: 999999, event: "rbac", value: 0 } },
  { method: "put", path: "/score/api/score/setting", body: { key: "rbac", value: 0 } },
  { method: "get", path: "/score/api/score/endurance", body: undefined },
  { method: "put", path: "/score/api/score/endurance", body: { num: 999999 } },
];

test.describe("score RBAC", () => {
  for (const { method, path, body } of adminGated) {
    test(`chief is rejected (403) on ${method.toUpperCase()} ${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: storageStatePath("chief") });
      const res = await ctx.request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(403);
      await ctx.close();
    });

    test(`unauthenticated is rejected (401) on ${method.toUpperCase()} ${path}`, async ({ request }) => {
      const res = await request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(401);
    });
  }
});
