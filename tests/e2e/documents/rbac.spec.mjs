import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Documents gate (documents/index.mjs authRoleFn ~lines 168-176):
//   /api/internal/* -> "admin" (but the internal-service middleware grants admin only
//                       when a valid X-Internal-Service header is present; Caddy strips
//                       that header from external requests, so an external caller with no
//                       header falls through to JWT auth and is gated at "admin")
//   /api/admin*     -> "chief"
//   /api/*          -> "student"  (and SPA -> "student", /admin -> "chief")
// student sits one level below chief -> expect 403 on /api/admin/* endpoints.
// Unauthenticated -> 401 on /api/admin/*.
// /api/internal/* with NO internal secret header -> rejected (401 unauth / 403 student).

// chief-gated admin endpoints; student must be rejected (403).
const adminGated = [
  { method: "get", path: "/documents/api/admin/sessions", body: undefined },
  { method: "post", path: "/documents/api/admin/sessions", body: { name: `rbac-${Date.now()}`, year: new Date().getFullYear() } },
  { method: "get", path: "/documents/api/admin/student-teams", body: undefined },
];

test.describe("documents RBAC", () => {
  for (const { method, path, body } of adminGated) {
    test(`student is rejected (403) on ${method.toUpperCase()} ${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: storageStatePath("student") });
      const res = await ctx.request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(403);
      await ctx.close();
    });

    test(`unauthenticated is rejected (401) on ${method.toUpperCase()} ${path}`, async ({ request }) => {
      const res = await request[method](path, body === undefined ? {} : { data: body });
      expect(res.status()).toBe(401);
    });
  }

  // Internal API without the X-Internal-Service header (Caddy strips it externally).
  // Falls through to the "admin" gate: unauthenticated -> 401, authenticated student -> 403.
  test("unauthenticated is rejected (401) on internal DELETE /documents/api/internal/team/999999", async ({ request }) => {
    const res = await request.delete("/documents/api/internal/team/999999");
    expect(res.status()).toBe(401);
  });

  test("student is rejected (403) on internal DELETE /documents/api/internal/team/999999 (no secret)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("student") });
    const res = await ctx.request.delete("/documents/api/internal/team/999999");
    expect(res.status()).toBe(403);
    await ctx.close();
  });
});
