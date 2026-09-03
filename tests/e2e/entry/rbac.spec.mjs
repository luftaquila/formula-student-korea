import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Competition Teams gate: public active-team reads, admin mutations.
// GET /api/vehicle-types and /api/health are public; every other route is "admin".
// Entry is an Admin tool with no service grant, so no Official profile may write.
// NOTE: auth/rbac.spec.mjs already covers student->POST /competition/api/v1/teams 403 and
// unauth->POST 401. Here we cover officials (including fully granted managers), the
// PATCH/DELETE write surface, vehicle-types writes, and the genuinely public reads.

const YEAR = currentCompetitionYear();

// One representative endpoint per HTTP method that the admin gate protects.
const protectedWrites = [
  { method: "post", path: `/competition/api/v1/teams?year=${YEAR}`, body: { number: Date.now() % 100000, university: "rbac-univ", name: "rbac-team" } },
  { method: "patch", path: `/competition/api/v1/teams/999999`, body: { university: "rbac-univ" } },
  { method: "post", path: `/competition/api/v1/vehicle-types?year=${YEAR}`, body: { name: `rbac-${Date.now()}` } },
  { method: "patch", path: `/competition/api/v1/vehicle-types/999999`, body: { name: `rbac-${Date.now()}` } },
  { method: "delete", path: `/competition/api/v1/vehicle-types/999999`, body: {} },
];

// Public reads — unauthenticated must succeed.
const publicReads = [
  `/competition/api/v1/teams?year=${YEAR}`,
  "/competition/api/v1/meta",
  `/competition/api/v1/vehicle-types?year=${YEAR}`,
];

test.describe("entry RBAC", () => {
  test("officials are rejected on every representative write regardless of their grants", async ({ browser }) => {
    for (const profile of ["operationsOperator", "operationsManager"]) {
      const ctx = await browser.newContext({ storageState: storageStatePath(profile) });
      try {
        for (const { method, path, body } of protectedWrites) {
          await test.step(`${profile}: ${method.toUpperCase()} ${path.split("?")[0]}`, async () => {
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
