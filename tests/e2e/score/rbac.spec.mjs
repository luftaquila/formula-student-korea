import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Score endpoints require score.operate or score.manage. This profile has
// neither permission, so every representative protected route must return 403.
// Unauthenticated callers receive 401.

const adminGated = [
  { method: "get", path: "/competition/api/v1/score/score", body: undefined },
  { method: "put", path: "/competition/api/v1/score/score/manual", body: { num: 999999, event: "rbac", value: 0 } },
  { method: "put", path: "/competition/api/v1/score/score/penalty", body: { num: 999999, event: "rbac", value: 0 } },
  { method: "put", path: "/competition/api/v1/score/score/setting", body: { key: "rbac", value: 0 } },
  { method: "get", path: "/competition/api/v1/score/score/endurance", body: undefined },
  { method: "put", path: "/competition/api/v1/score/score/endurance", body: { num: 999999 } },
];

test.describe("score RBAC", () => {
  test("official without score permissions is rejected on every representative endpoint", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    try {
      for (const { method, path, body } of adminGated) {
        await test.step(`${method.toUpperCase()} ${path}`, async () => {
          const res = await ctx.request[method](path, body === undefined ? {} : { data: body });
          expect(res.status()).toBe(403);
        });
      }
    } finally {
      await ctx.close();
    }
  });

  test("unauthenticated callers are rejected on every representative score endpoint", async ({ request }) => {
    for (const { method, path, body } of adminGated) {
      await test.step(`${method.toUpperCase()} ${path}`, async () => {
        const res = await request[method](path, body === undefined ? {} : { data: body });
        expect(res.status()).toBe(401);
      });
    }
  });
});
