import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Documents gate (documents/index.mjs authRoleFn ~lines 168-176):
//   Legacy team lifecycle endpoints are absent from the Competition boundary.
//   /api/admin*     -> "chief"
//   /api/*          -> "student"  (and SPA -> "student", /admin -> "chief")
// student sits one level below chief -> expect 403 on /api/admin/* endpoints.
// Unauthenticated -> 401 on /api/admin/*.

// chief-gated admin endpoints; student must be rejected (403).
const adminGated = [
  { method: "get", path: "/competition/api/v1/documents/admin/sessions", body: undefined },
  { method: "post", path: "/competition/api/v1/documents/admin/sessions", body: { name: `rbac-${Date.now()}`, year: currentCompetitionYear() } },
  { method: "get", path: "/competition/api/v1/documents/admin/student-teams", body: undefined },
];

test.describe("documents RBAC", () => {
  test("student is rejected on every representative admin endpoint", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("student") });
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

  test("unauthenticated callers are rejected on every representative admin endpoint", async ({ request }) => {
    for (const { method, path, body } of adminGated) {
      await test.step(`${method.toUpperCase()} ${path}`, async () => {
        const res = await request[method](path, body === undefined ? {} : { data: body });
        expect(res.status()).toBe(401);
      });
    }
  });

  test("the removed internal team endpoint cannot mutate data", async ({ request, browser }) => {
    const res = await request.delete("/competition/api/v1/documents/internal/team/999999");
    expect(res.status()).toBe(404);

    const ctx = await browser.newContext({ storageState: storageStatePath("student") });
    try {
      const studentRes = await ctx.request.delete("/competition/api/v1/documents/internal/team/999999");
      expect(studentRes.status()).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});
