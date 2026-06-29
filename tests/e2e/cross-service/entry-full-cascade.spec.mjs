import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Bulk-deletion fan-out:
// The existing entry-deletion-cascade spec deletes ONE entry and watches a single
// team disappear. This spec exercises the BULK path: DELETE /entry/api/entries?year=
// clears every entry for a year and entry.notifyEntryDeleted() then fans out a
// DELETE /api/internal/team/:num?year= to BOTH queue and documents for each removed
// num. We seed an ISOLATED non-current year with our own nums/emails so we never
// touch shared seed data (the current-year tables other shards assert against) and
// can safely wipe the whole year.
//
// Queue registration only works for the current year, so this spec asserts the
// documents side of the fan-out (queue still receives an idempotent internal DELETE,
// just with nothing to remove for a non-current year).

// Isolated, in-range (2000-2099) year, unique per run to avoid colliding with a
// parallel shard or a retry that also wipes a whole year.
// PAST isolated year (2010-2019): in-range, not the current/seeded year, and
// kept below the current year so it never floats to the top of any year
// dropdown (descending order) and breaks "first option = current year" specs.
const ISO_YEAR = 2010 + (Date.now() % 10);
const STAMP = Date.now();
// Unique team nums far from seeded 1..32; documents student_team is UNIQUE(team_num, year).
const NUMS = [STAMP % 100000 + 500, STAMP % 100000 + 501, STAMP % 100000 + 502];
const emailFor = (num) => `e2e-fullcascade-${STAMP}-${num}@test.com`;

test.describe("Entry bulk deletion fans out cascade to documents", () => {
  test.use({ storageState: storageStatePath("admin") });

  const adminHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("admin"),
  };
  const chiefHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("chief"),
  };

  async function deleteAllEntries() {
    return fetch(`${BASE_URL}/entry/api/entries?year=${ISO_YEAR}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }

  test.afterAll(async () => {
    // Idempotent cleanup: wipe the isolated year's entries again (also re-fires the
    // fan-out, which is harmless), then drop any leftover documents mappings.
    try { await deleteAllEntries(); } catch { /* ignore */ }
    for (const num of NUMS) {
      try {
        await fetch(
          `${BASE_URL}/documents/api/admin/student-teams/${encodeURIComponent(emailFor(num))}/${ISO_YEAR}`,
          { method: "DELETE", headers: chiefHeaders },
        );
      } catch { /* ignore */ }
    }
  });

  test("deleting all entries for a year removes the teams from documents", async () => {
    // 1. Seed isolated entries for the isolated year.
    for (const num of NUMS) {
      const res = await fetch(`${BASE_URL}/entry/api/entries?year=${ISO_YEAR}`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ num, univ: `풀캐스케이드대-${num}`, team: `FullCascade ${num}` }),
      });
      expect(res.status).toBe(201);
    }

    // 2. Create matching documents student-team mappings (unique email per num so the
    //    student_team email-PK never collides across runs).
    for (const num of NUMS) {
      const res = await fetch(`${BASE_URL}/documents/api/admin/student-teams`, {
        method: "POST",
        headers: chiefHeaders,
        body: JSON.stringify({ email: emailFor(num), team_num: num, year: ISO_YEAR }),
      });
      expect(res.status).toBe(201);
    }

    // 3. Confirm documents holds all of our mappings before deletion.
    const beforeRes = await fetch(
      `${BASE_URL}/documents/api/admin/student-teams?year=${ISO_YEAR}`,
      { headers: chiefHeaders },
    );
    expect(beforeRes.status).toBe(200);
    const before = await beforeRes.json();
    for (const num of NUMS) {
      expect(before.some((m) => m.team_num === num)).toBeTruthy();
    }

    // 4. Bulk-delete every entry for the isolated year → fan-out to queue + documents.
    const delRes = await deleteAllEntries();
    expect(delRes.status).toBe(200);

    // 5. The fan-out is eventual (Promise.allSettled of inter-service DELETEs); poll
    //    until none of our nums remain in documents for this year.
    await expect.poll(async () => {
      const res = await fetch(
        `${BASE_URL}/documents/api/admin/student-teams?year=${ISO_YEAR}`,
        { headers: chiefHeaders },
      );
      const data = await res.json();
      return NUMS.every((num) => !data.some((m) => m.team_num === num));
    }, { timeout: 10000 }).toBeTruthy();

    // 6. Entry table for the isolated year is now empty of our nums.
    const entriesRes = await fetch(`${BASE_URL}/entry/api/entries?year=${ISO_YEAR}`, {
      headers: adminHeaders,
    });
    expect(entriesRes.status).toBe(200);
    const entries = await entriesRes.json();
    for (const num of NUMS) {
      expect(entries[num]).toBeUndefined();
    }
  });
});
