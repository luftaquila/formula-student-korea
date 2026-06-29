import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Entry gate (entry/index.mjs authRoleFn): GET /api/entries, /api/years,
// GET /api/vehicle-types and /api/health are public; every other route is "admin".
// NOTE: auth/rbac.spec.mjs already covers student->POST /entry/api/entries 403 and
// unauth->POST 401. Here we cover official + chief (still below admin), the PATCH/DELETE
// write surface, vehicle-types writes, and the genuinely public reads.

const YEAR = new Date().getFullYear();

// One representative endpoint per HTTP method that the admin gate protects.
const protectedWrites = [
  { method: "post", path: `/entry/api/entries?year=${YEAR}`, body: { num: Date.now() % 100000, univ: "rbac-univ", team: "rbac-team", type: null } },
  { method: "patch", path: `/entry/api/entries/999999?year=${YEAR}`, body: { univ: "rbac-univ" } },
  { method: "delete", path: `/entry/api/entries/999999?year=${YEAR}`, body: {} },
  { method: "post", path: `/entry/api/vehicle-types?year=${YEAR}`, body: { name: `rbac-${Date.now()}` } },
  { method: "patch", path: `/entry/api/vehicle-types/999999?year=${YEAR}`, body: { name: `rbac-${Date.now()}` } },
  { method: "delete", path: `/entry/api/vehicle-types/999999?year=${YEAR}`, body: {} },
];

// Public reads — unauthenticated must succeed.
const publicReads = [
  `/entry/api/entries?year=${YEAR}`,
  "/entry/api/years",
  `/entry/api/vehicle-types?year=${YEAR}`,
];

test.describe("entry RBAC", () => {
  for (const role of ["official", "chief"]) {
    for (const { method, path, body } of protectedWrites) {
      test(`${role} is rejected (403) on ${method.toUpperCase()} ${path.split("?")[0]}`, async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath(role) });
        const res = await ctx.request[method](path, { data: body });
        expect(res.status()).toBe(403);
        await ctx.close();
      });
    }
  }

  for (const { method, path, body } of protectedWrites) {
    test(`unauthenticated is rejected (401) on ${method.toUpperCase()} ${path.split("?")[0]}`, async ({ request }) => {
      const res = await request[method](path, { data: body });
      expect(res.status()).toBe(401);
    });
  }

  for (const path of publicReads) {
    test(`unauthenticated read succeeds (200) on GET ${path.split("?")[0]}`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
    });
  }
});
