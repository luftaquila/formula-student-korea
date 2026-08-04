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
  test("official and chief are rejected on every representative write", async ({ browser }) => {
    for (const role of ["official", "chief"]) {
      const ctx = await browser.newContext({ storageState: storageStatePath(role) });
      try {
        for (const { method, path, body } of protectedWrites) {
          await test.step(`${role}: ${method.toUpperCase()} ${path.split("?")[0]}`, async () => {
            const res = await ctx.request[method](path, { data: body });
            expect(res.status()).toBe(403);
          });
        }
      } finally {
        await ctx.close();
      }
    }
  });

  test("unauthenticated callers are rejected on every representative write", async ({ request }) => {
    for (const { method, path, body } of protectedWrites) {
      await test.step(`${method.toUpperCase()} ${path.split("?")[0]}`, async () => {
        const res = await request[method](path, { data: body });
        expect(res.status()).toBe(401);
      });
    }
  });

  test("unauthenticated callers can read every public endpoint", async ({ request }) => {
    for (const path of publicReads) {
      await test.step(`GET ${path.split("?")[0]}`, async () => {
        const res = await request.get(path);
        expect(res.status()).toBe(200);
      });
    }
  });
});
