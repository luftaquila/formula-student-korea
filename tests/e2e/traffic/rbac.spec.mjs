import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Traffic gate (traffic/index.mjs authRoleFn ~lines 178-181):
//   /api/health and /api/time -> public; EVERYTHING else -> "admin".
// chief sits one level below admin -> expect 403 on every protected route.
// Unauthenticated -> 401.

// Representative admin-gated endpoints across read + write surfaces.
const adminGated = [
  { method: "get", path: "/traffic/api/records", body: undefined },
  { method: "post", path: "/traffic/api/records", body: { name: `rbac-${Date.now()}` } },
  { method: "put", path: "/traffic/api/event-modes/practice", body: { enabled: true } },
  { method: "get", path: "/traffic/api/event-modes", body: undefined },
];

test.describe("traffic RBAC", () => {
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

  test("unauthenticated read succeeds (200) on GET /traffic/api/time (public)", async ({ request }) => {
    const res = await request.get("/traffic/api/time");
    expect(res.status()).toBe(200);
  });
});
