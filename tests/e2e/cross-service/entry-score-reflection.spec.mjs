import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Score aggregation and endurance inputs reflect entry mutations:
// score.computeScore() reads the entry list from its team-state cache (pulled
// from entry's versioned snapshot, invalidated by entry's SSE) and returns it as
// `entries` (keyed by num). Convergence after an entry mutation is asynchronous
// but fast. When an entry is deleted, score must drop that team once its cache
// converges. We seed an isolated entry in the CURRENT year (the year the score
// dashboard defaults to and the year the seeded template/traffic data live in),
// poll until score lists it, delete it, then poll until score drops it.

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

    // 2. score's aggregation lists the team once its team-state cache pulls the
    //    new snapshot (SSE-triggered, eventual from the caller's view) — poll.
    await expect.poll(async () => {
      const entries = await scoreEntries();
      return Boolean(entries[NUM] && entries[NUM].team === team);
    }, { timeout: 15_000 }).toBeTruthy();

    // 3. Delete the entry (writes a tombstone; always 200, no pending state).
    const delRes = await deleteEntry();
    expect(delRes.status).toBe(200);

    // 4. score drops the team once its team-state cache converges — poll.
    await expect.poll(async () => {
      const entries = await scoreEntries();
      return entries[NUM] === undefined;
    }, { timeout: 15_000 }).toBeTruthy();
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

    // Score's team-state cache converges asynchronously after the create. Wait
    // for the API to list the team BEFORE loading the page: the entry:entries
    // relay event fired at create time, so a page opened later would miss it
    // and only render the team if the initial load already includes it.
    await expect.poll(async () => {
      const entries = await scoreEntries();
      return Boolean(entries[NUM] && entries[NUM].team === team);
    }, { timeout: 15_000 }).toBeTruthy();

    await page.goto("/score/endurance");
    const row = page.locator("tbody tr").filter({ hasText: team });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('input[data-field="fuel_consumed"]')).toBeEnabled();
    await expect(row.locator('input[data-field="electric_net_energy"]')).toBeDisabled();

    // Hold an older score-only refresh after it has captured the C snapshot. The
    // later entry event starts a full load with the E snapshot; releasing this
    // response afterward must not roll the inputs back to C.
    let holdNextScoreRequest = true;
    let releaseHeldRequest;
    let markHeldRequestStarted;
    let markHeldRequestFinished;
    const heldRequestStarted = new Promise((resolve) => { markHeldRequestStarted = resolve; });
    const heldRequestRelease = new Promise((resolve) => { releaseHeldRequest = resolve; });
    const heldRequestFinished = new Promise((resolve) => { markHeldRequestFinished = resolve; });
    const scorePattern = `**/score/api/score?year=${YEAR}`;
    await page.route(scorePattern, async (route) => {
      if (!holdNextScoreRequest) return route.continue();
      holdNextScoreRequest = false;
      const response = await route.fetch();
      markHeldRequestStarted();
      await heldRequestRelease;
      await route.fulfill({ response });
      markHeldRequestFinished();
    });

    try {
      const measurementRes = await fetch(`${BASE_URL}/score/api/score/endurance`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ year: YEAR, team_num: NUM, field: "fuel_consumed", value: 1 }),
      });
      expect(measurementRes.status).toBe(200);
      await Promise.race([
        heldRequestStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stale score refresh did not start")), 10000)),
      ]);

      const patchRes = await fetch(`${BASE_URL}/entry/api/entries/${NUM}?year=${YEAR}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ num: NUM, univ: `유형반영대-${NUM}`, team, type: "E-Formula" }),
      });
      expect(patchRes.status).toBe(200);

      await expect(row.locator('input[data-field="fuel_consumed"]')).toBeDisabled({ timeout: 10000 });
      await expect(row.locator('input[data-field="electric_net_energy"]')).toBeEnabled({ timeout: 10000 });

      releaseHeldRequest();
      await Promise.race([
        heldRequestFinished,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stale score refresh did not finish")), 10000)),
      ]);
      await expect(row.locator('input[data-field="fuel_consumed"]')).toBeDisabled();
      await expect(row.locator('input[data-field="electric_net_energy"]')).toBeEnabled();
    } finally {
      releaseHeldRequest();
      await page.unroute(scorePattern);
    }
  });
});
