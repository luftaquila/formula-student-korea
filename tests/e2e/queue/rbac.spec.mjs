import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Queue gate (queue/index.mjs authRoleFn ~lines 228-249):
//   chief-only: /api/admin/priority/*, /api/admin/history/*, /api/admin/settings (non-GET),
//               /api/admin/inspection/:type (PATCH), .../visibility, .../ignore,
//               /api/admin/booths/:type/config
//   official:   everything else under /api/admin (register/cancel/booth toggle/enter/exit/stats)
//   public:     /api/events, /api/active, /api/booths/*, /api/state/*
// official sits one level below chief -> expect 403 on chief endpoints.
// Unauthenticated -> 401 on any /api/admin/* (gate returns chief/official, never null).

// Chief-gated endpoints; official must be rejected (403).
const chiefOnly = [
  { method: "get", path: "/queue/api/admin/priority/battery", body: undefined },
  { method: "post", path: "/queue/api/admin/priority/battery", body: { num: 999999, priority: 0 } },
  { method: "delete", path: "/queue/api/admin/priority/battery/all", body: {} },
  { method: "get", path: "/queue/api/admin/history/status", body: undefined },
  { method: "delete", path: "/queue/api/admin/history/battery", body: {} },
  { method: "patch", path: "/queue/api/admin/settings/sms", body: { enabled: false } },
  { method: "patch", path: "/queue/api/admin/inspection/battery/visibility", body: { hidden: false } },
  { method: "put", path: "/queue/api/admin/inspection/battery/ignore", body: { ignore_priority: false } },
  { method: "patch", path: "/queue/api/admin/inspection/battery", body: { active: true } },
  { method: "patch", path: "/queue/api/admin/booths/battery/config", body: { count: 1 } },
];

// official-gated endpoint; proves the tier exists and that unauth is 401 there too.
const officialOnly = [
  { method: "get", path: "/queue/api/admin/all", body: undefined },
];

test.describe("queue RBAC", () => {
  for (const { method, path, body } of chiefOnly) {
    test(`official is rejected (403) on ${method.toUpperCase()} ${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: storageStatePath("official") });
      const res = await ctx.request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(403);
      await ctx.close();
    });

    test(`unauthenticated is rejected (401) on ${method.toUpperCase()} ${path}`, async ({ request }) => {
      const res = await request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(401);
    });
  }

  for (const { method, path } of officialOnly) {
    test(`unauthenticated is rejected (401) on official endpoint ${method.toUpperCase()} ${path}`, async ({ request }) => {
      const res = await request[method](path);
      expect(res.status()).toBe(401);
    });
  }

  test("unauthenticated read succeeds (200) on GET /queue/api/active (public)", async ({ request }) => {
    const res = await request.get("/queue/api/active");
    expect(res.status()).toBe(200);
  });
});
