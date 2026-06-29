import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Entry vehicle-type ↔ entry referential integrity (API-level).
//
// Cascades only touch entries in the SAME year as the vehicle type
// (entry/index.mjs PATCH/DELETE vehicle-types use getTableName(vtYear)), so
// every test pins a unique year >= 2090 and unique nums/type names via
// Date.now() to stay isolated when the suite runs in parallel.
test.describe("Entry data integrity (vehicle types <-> entries)", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Unique year per test keeps the year-scoped vehicle_types_<year> and
  // entry_<year> tables isolated from other workers and from seeded data.
  let yearCounter = 2090;
  function nextYear() {
    return yearCounter++;
  }

  async function createVehicleType(request, year, name, color) {
    const res = await request.post(`/entry/api/vehicle-types?year=${year}`, {
      data: color === undefined ? { name } : { name, color },
    });
    return res;
  }

  async function getEntries(request, year) {
    const res = await request.get(`/entry/api/entries?year=${year}`);
    expect(res.status()).toBe(200);
    return res.json();
  }

  test("renaming a vehicle type cascades to entries' type in the same year", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const request = ctx.request;
      const year = nextYear();
      const typeName = `T_${Date.now()}`;
      const renamed = `${typeName}_RENAMED`;
      const num = 101;

      const createTypeRes = await createVehicleType(request, year, typeName);
      expect(createTypeRes.status()).toBe(201);
      const typeBody = await createTypeRes.json();
      expect(typeBody.name).toBe(typeName);
      const typeId = typeBody.id;

      // Entry referencing the type, in the same year.
      const createEntryRes = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "무결성대학교", team: "Integrity Racing", type: typeName },
      });
      expect(createEntryRes.status()).toBe(201);

      // Rename the type.
      const patchRes = await request.patch(`/entry/api/vehicle-types/${typeId}?year=${year}`, {
        data: { name: renamed },
      });
      expect(patchRes.status()).toBe(200);

      // Entry's type should now reflect the new name.
      const entries = await getEntries(request, year);
      expect(entries[num]).toBeDefined();
      expect(entries[num].type).toBe(renamed);
    } finally {
      await ctx.close();
    }
  });

  test("deleting a vehicle type NULLs entries' type in the same year", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const request = ctx.request;
      const year = nextYear();
      const typeName = `D_${Date.now()}`;
      const num = 102;

      const createTypeRes = await createVehicleType(request, year, typeName);
      expect(createTypeRes.status()).toBe(201);
      const typeId = (await createTypeRes.json()).id;

      const createEntryRes = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "삭제대학교", team: "Delete Racing", type: typeName },
      });
      expect(createEntryRes.status()).toBe(201);

      // Sanity: type is set before deletion.
      const before = await getEntries(request, year);
      expect(before[num].type).toBe(typeName);

      const deleteRes = await request.delete(`/entry/api/vehicle-types/${typeId}?year=${year}`);
      expect(deleteRes.status()).toBe(200);

      // Entry's type is cleared (NULL serializes to null in JSON).
      const after = await getEntries(request, year);
      expect(after[num]).toBeDefined();
      expect(after[num].type == null).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("vehicle type create rejects duplicate name with 400", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const request = ctx.request;
      const year = nextYear();
      const typeName = `Dup_${Date.now()}`;

      const first = await createVehicleType(request, year, typeName);
      expect(first.status()).toBe(201);

      const second = await createVehicleType(request, year, typeName);
      expect(second.status()).toBe(400);
      expect(await second.text()).toBe("이미 존재하는 차량 유형입니다.");
    } finally {
      await ctx.close();
    }
  });

  test("vehicle type create falls back to default color on invalid color", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const request = ctx.request;
      const year = nextYear();
      const typeName = `Color_${Date.now()}`;

      // "not-a-real-color" is not in VEHICLE_COLORS -> backend falls back to "blue".
      const res = await createVehicleType(request, year, typeName, "not-a-real-color");
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.color).toBe("blue");
    } finally {
      await ctx.close();
    }
  });

  test("entry create rejects empty univ, empty team, nonexistent type, and duplicate num", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    try {
      const request = ctx.request;
      const year = nextYear();
      const num = 103;

      // Empty univ -> 400.
      const emptyUniv = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "   ", team: "Team", type: null },
      });
      expect(emptyUniv.status()).toBe(400);
      expect(await emptyUniv.text()).toBe("올바르지 않은 학교명입니다.");

      // Empty team -> 400.
      const emptyTeam = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "대학교", team: "   ", type: null },
      });
      expect(emptyTeam.status()).toBe(400);
      expect(await emptyTeam.text()).toBe("올바르지 않은 팀명입니다.");

      // Nonexistent type -> 400.
      const badType = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "대학교", team: "Team", type: `ghost_${Date.now()}` },
      });
      expect(badType.status()).toBe(400);
      expect(await badType.text()).toBe("존재하지 않는 차량 유형입니다.");

      // Create a valid entry, then a duplicate num -> 400 (PK constraint).
      const ok = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "대학교", team: "Team", type: null },
      });
      expect(ok.status()).toBe(201);

      const dup = await request.post(`/entry/api/entries?year=${year}`, {
        data: { num, univ: "다른대학교", team: "Other", type: null },
      });
      expect(dup.status()).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
