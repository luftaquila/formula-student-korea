import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Score aggregation and endurance inputs reflect entry mutations:
// score.computeScore() fetches the entry list from the entry service for the
// requested year and returns it as `entries` (keyed by num). When an entry is
// deleted, the next /score/api/score call must no longer list that team. We seed
// an isolated entry in the CURRENT year (the year the score dashboard defaults to
// and the year the seeded template/traffic data live in), confirm score lists it,
// delete it, then poll until score drops it.

const YEAR = new Date().getFullYear();
// Unique high num avoids the seeded 1..32 range and collisions with parallel shards.
const NUM = (Date.now() % 100000) + 700;

test.describe("Entry changes reflected in score", () => {
  test.use({ storageState: storageStatePath("admin") });

  const adminHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("admin"),
  };

  async function deleteEntry() {
    return fetch(`${BASE_URL}/entry/api/entries/${NUM}?year=${YEAR}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }

  async function scoreEntries() {
    const res = await fetch(`${BASE_URL}/score/api/score?year=${YEAR}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    return data.entries || {};
  }

  async function ensureVehicleType(name) {
    const listRes = await fetch(`${BASE_URL}/entry/api/vehicle-types?year=${YEAR}`, { headers: adminHeaders });
    expect(listRes.status).toBe(200);
    const types = await listRes.json();
    if (types.some((type) => type.name === name)) return;
    const createRes = await fetch(`${BASE_URL}/entry/api/vehicle-types?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name }),
    });
    expect(createRes.status).toBe(201);
  }

  test.afterAll(async () => {
    // Idempotent cleanup (no-op if the test already deleted it).
    try { await deleteEntry(); } catch { /* ignore */ }
  });

  test("score drops a team after its entry is deleted", async () => {
    const team = `ScoreReflect ${NUM}`;

    // 1. Seed an isolated entry in the current year.
    const createRes = await fetch(`${BASE_URL}/entry/api/entries?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ num: NUM, univ: `점수반영대-${NUM}`, team }),
    });
    expect(createRes.status).toBe(201);

    // 2. score's aggregation lists the team. Aggregation fans out to entry/inspection/
    //    traffic and is eventual from the caller's view, so poll until it appears.
    await expect.poll(async () => {
      const entries = await scoreEntries();
      return entries[NUM] && entries[NUM].team === team;
    }, { timeout: 10000 }).toBeTruthy();

    // 3. Delete the entry.
    const delRes = await deleteEntry();
    expect(delRes.status).toBe(200);

    // 4. score no longer lists the team on its next aggregation.
    await expect.poll(async () => {
      const entries = await scoreEntries();
      return entries[NUM] === undefined;
    }, { timeout: 10000 }).toBeTruthy();
  });

  test("score endurance inputs follow a same-number vehicle-type edit live", async ({ page }) => {
    const team = `Score Energy Type ${NUM}`;
    await deleteEntry().catch(() => {});
    await ensureVehicleType("C-Formula");
    await ensureVehicleType("E-Formula");

    const createRes = await fetch(`${BASE_URL}/entry/api/entries?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ num: NUM, univ: `유형반영대-${NUM}`, team, type: "C-Formula" }),
    });
    expect(createRes.status).toBe(201);

    await page.goto("/score/endurance");
    const row = page.locator("tbody tr").filter({ hasText: team });
    await expect(row).toBeVisible();
    await expect(row.locator('input[data-field="fuel_consumed"]')).toBeEnabled();
    await expect(row.locator('input[data-field="electric_net_energy"]')).toBeDisabled();

    const patchRes = await fetch(`${BASE_URL}/entry/api/entries/${NUM}?year=${YEAR}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ num: NUM, univ: `유형반영대-${NUM}`, team, type: "E-Formula" }),
    });
    expect(patchRes.status).toBe(200);

    await expect(row.locator('input[data-field="fuel_consumed"]')).toBeDisabled({ timeout: 10000 });
    await expect(row.locator('input[data-field="electric_net_energy"]')).toBeEnabled({ timeout: 10000 });
  });
});
