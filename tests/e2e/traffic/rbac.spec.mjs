import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Traffic endpoints require traffic.operate or traffic.manage, except the
// public health/time surface. This profile has neither permission, so every
// representative protected route must return 403. Unauthenticated callers
// receive 401.

// Representative admin-gated endpoints across read + write surfaces.
const adminGated = [
  { method: "get", path: "/competition/api/v1/traffic/records", body: undefined },
  { method: "post", path: "/competition/api/v1/traffic/records", body: { name: `rbac-${Date.now()}` } },
  { method: "put", path: "/competition/api/v1/traffic/event-modes/practice", body: { enabled: true } },
  { method: "get", path: "/competition/api/v1/traffic/event-modes", body: undefined },
];

test.describe("traffic RBAC", () => {
  test("official without traffic permissions is rejected on every protected endpoint", async ({ browser }) => {
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

  test("unauthenticated callers are rejected on every representative protected endpoint", async ({ request }) => {
    for (const { method, path, body } of adminGated) {
      await test.step(`${method.toUpperCase()} ${path}`, async () => {
        const res = await request[method](path, body === undefined ? {} : { data: body });
        expect(res.status()).toBe(401);
      });
    }
  });

  test("unauthenticated read succeeds (200) on GET /competition/api/v1/traffic/time (public)", async ({ request }) => {
    const res = await request.get("/competition/api/v1/traffic/time");
    expect(res.status()).toBe(200);
  });
});
