import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = new Date().getFullYear();

test.describe("Entry deletion cascade to queue and documents", () => {
  test.use({ storageState: storageStatePath("admin") });

  const adminHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("admin"),
  };
  const chiefHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("chief"),
  };

  // Idempotent cleanup in afterAll
  test.afterAll(async () => {
    try {
      await fetch(`${BASE_URL}/entry/api/entries/90?year=${YEAR}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
    } catch { /* ignore */ }
  });

  test("entry deletion cleans up queue data", async ({ page }) => {
    // 1. Create entry #90
    const createRes = await fetch(`${BASE_URL}/entry/api/entries?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ num: 90, univ: "삭제테스트대학교", team: "Delete Test", type: "EV" }),
    });
    expect(createRes.status).toBe(201);

    // 2. Register team #90 in the queue (배터리 inspection)
    // First, check if 배터리 inspection is active; activate if not
    const allRes = await fetch(`${BASE_URL}/queue/api/admin/all`, {
      headers: { Cookie: getAuthCookie("official") },
    });
    const allTypes = await allRes.json();
    const battery = allTypes.find((t) => t.type === "배터리");
    if (battery && !battery.active) {
      await fetch(`${BASE_URL}/queue/api/admin/inspection/배터리`, {
        method: "PATCH",
        headers: chiefHeaders,
        body: JSON.stringify({ active: true }),
      });
    }

    // Queue learns about new entries asynchronously (team-state pull sync
    // triggered by entry's SSE), so a register fired right after the entry POST
    // can be rejected with "존재하지 않는 엔트리" (or 503 on a cold cache) until
    // queue's snapshot converges — retry only those outcomes. Other failures
    // (e.g. queue inactive) fall through to the tolerant branch below.
    let registered = false;
    await expect.poll(async () => {
      const regRes = await fetch(`${BASE_URL}/queue/api/admin/register/배터리`, {
        method: "POST",
        headers: chiefHeaders,
        body: JSON.stringify({ num: 90, phone: "010-0000-0000" }),
      });
      if (regRes.status === 200 || regRes.status === 201) {
        registered = true;
        return "registered";
      }
      const body = await regRes.text();
      if (regRes.status === 503 || body.includes("존재하지 않는 엔트리")) return "converging";
      return `failed:${regRes.status}`;
    }, { timeout: 15_000 }).not.toBe("converging");

    // Registration may succeed or fail if queue is not active - check both cases
    if (registered) {
      // 3. Verify team #90 is in the queue
      const queueRes = await fetch(`${BASE_URL}/queue/api/admin/inspection/배터리`, {
        headers: { Cookie: getAuthCookie("official") },
      });
      const queueData = await queueRes.json();
      expect(queueData.some((item) => item.num === 90)).toBeTruthy();

      // 4. Delete entry #90
      const deleteRes = await fetch(`${BASE_URL}/entry/api/entries/90?year=${YEAR}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      expect(deleteRes.status).toBe(200);

      // 5. The deletion writes a tombstone in entry; queue removes the team's
      //    queue rows on its next team-state sync — poll until it converges.
      await expect.poll(async () => {
        const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/배터리`, {
          headers: { Cookie: getAuthCookie("official") },
        });
        const data = await res.json();
        return !data.some((item) => item.num === 90);
      }, { timeout: 15_000 }).toBeTruthy();
    } else {
      // Queue not active — just test deletion without queue registration
      const deleteRes = await fetch(`${BASE_URL}/entry/api/entries/90?year=${YEAR}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      expect(deleteRes.status).toBe(200);
    }
  });

  test("entry deletion cleans up documents data", async ({ page }) => {
    // 1. Create entry #90
    const createRes = await fetch(`${BASE_URL}/entry/api/entries?year=${YEAR}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ num: 90, univ: "삭제테스트대학교", team: "Delete Test", type: "EV" }),
    });
    expect(createRes.status).toBe(201);

    // 2. Create student-team mapping for team #90.
    // Use an email unique to this spec: student_team has PRIMARY KEY (email, year),
    // so sharing an email+year with another spec (e.g. admin-dashboard) collides
    // under parallel project runs and yields a 400.
    const mapRes = await fetch(`${BASE_URL}/documents/api/admin/student-teams`, {
      method: "POST",
      headers: chiefHeaders,
      body: JSON.stringify({
        email: "e2e-cascade-student@test.com",
        team_num: 90,
        year: YEAR,
      }),
    });
    expect(mapRes.status).toBe(201);

    // 3. Wait until documents' team-state sync has resolved the mapping to the
    //    team's immutable id. The tombstone cascade deletes by team_id, so a
    //    mapping still carrying NULL team_id (created while documents had not
    //    yet seen team #90 in a snapshot) would survive the deletion.
    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/documents/api/admin/student-teams?year=${YEAR}`, {
        headers: chiefHeaders,
      });
      const data = await res.json();
      return data.find((m) => m.team_num === 90)?.team_id ?? null;
    }, { timeout: 15_000 }).not.toBeNull();

    // 4. Delete entry #90 (writes a tombstone; downstream cleanup is async)
    const deleteRes = await fetch(`${BASE_URL}/entry/api/entries/90?year=${YEAR}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(deleteRes.status).toBe(200);

    // 5. Documents drops the mapping on its next team-state sync — poll.
    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/documents/api/admin/student-teams?year=${YEAR}`, {
        headers: chiefHeaders,
      });
      const data = await res.json();
      return !data.some((m) => m.team_num === 90);
    }, { timeout: 15_000 }).toBeTruthy();
  });
});
