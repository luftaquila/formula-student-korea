import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Queue gate (queue/index.mjs authRoleFn ~lines 228-249):
//   chief-only: /api/admin/register/*, /api/admin/priority/*, /api/admin/history/*, /api/admin/settings (non-GET),
//               /api/admin/inspection/:type (PATCH), .../visibility, .../ignore,
//               /api/admin/booths/:type/config
//   official:   everything else under /api/admin (cancel/booth toggle/enter/exit/stats)
//   public:     /api/events, /api/active, /api/booths/*, /api/state/*
// official sits one level below chief -> expect 403 on chief endpoints.
// Unauthenticated -> 401 on any /api/admin/* (gate returns chief/official, never null).

// Chief-gated endpoints; official must be rejected (403).
const chiefOnly = [
  { method: "post", path: "/competition/api/v1/queue/admin/register/battery", body: { num: 1, phone: "01000000000" } },
  { method: "get", path: "/competition/api/v1/queue/admin/priority/battery", body: undefined },
  { method: "post", path: "/competition/api/v1/queue/admin/priority/battery", body: { num: 999999, priority: 0 } },
  { method: "delete", path: "/competition/api/v1/queue/admin/priority/battery/all", body: {} },
  { method: "get", path: "/competition/api/v1/queue/admin/history/status", body: undefined },
  { method: "delete", path: "/competition/api/v1/queue/admin/history/battery", body: {} },
  { method: "patch", path: "/competition/api/v1/queue/admin/settings/sms", body: { enabled: false } },
  { method: "patch", path: "/competition/api/v1/queue/admin/inspection/battery/visibility", body: { hidden: false } },
  { method: "put", path: "/competition/api/v1/queue/admin/inspection/battery/ignore", body: { ignore_priority: false } },
  { method: "patch", path: "/competition/api/v1/queue/admin/inspection/battery", body: { active: true } },
  { method: "patch", path: "/competition/api/v1/queue/admin/booths/battery/config", body: { count: 1 } },
];

// official-gated endpoint; proves the tier exists and that unauth is 401 there too.
const officialOnly = [
  { method: "get", path: "/competition/api/v1/queue/admin/all", body: undefined },
  { method: "get", path: "/competition/api/v1/queue/admin/penalties", body: undefined },
  { method: "post", path: "/competition/api/v1/queue/admin/penalties/battery/999999/restore", body: undefined },
];

test.describe("queue RBAC", () => {
  test("official is rejected on every chief-only endpoint", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("official") });
    try {
      for (const { method, path, body } of chiefOnly) {
        await test.step(`${method.toUpperCase()} ${path}`, async () => {
          const res = await ctx.request[method](path, body === undefined ? {} : { data: body });
          expect(res.status()).toBe(403);
        });
      }
    } finally {
      await ctx.close();
    }
  });

  test("unauthenticated callers are rejected on every admin endpoint", async ({ request }) => {
    for (const { method, path, body } of [...chiefOnly, ...officialOnly]) {
      await test.step(`${method.toUpperCase()} ${path}`, async () => {
        const res = await request[method](path, body === undefined ? {} : { data: body });
        expect(res.status()).toBe(401);
      });
    }
  });

  test("the active queue endpoint remains public", async ({ request }) => {
    const res = await request.get("/competition/api/v1/queue/active");
    expect(res.status()).toBe(200);
  });

  test("official is redirected away from the chief-only registration page", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await ctx.newPage();
    await page.goto("/queue/register");
    await expect(page).not.toHaveURL(/\/queue\/register/);
    await ctx.close();
  });
});
