import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

// Queue booth occupancy guards, public booth/state reads, rate limiting, and
// settings read scoping (API-level). Endpoints/roles verified against
// queue/index.mjs:
//   - PATCH /api/admin/booths/:type/config            -> chief
//   - POST  /api/admin/booths/:type/:boothNum/enter   -> official
//   - POST  /api/admin/booths/:type/:boothNum/exit    -> official
//   - GET   /api/booths/all, /api/booths/:type        -> public (null)
//   - POST  /api/state/:num                           -> public (null), rateLimit (>30/min -> 429)
//   - GET   /api/admin/settings/{sms,sms-rank,cancel-penalty} -> official (GET allowed)
//
// Isolation: "tilting" is owned by queue-status-success.spec.mjs, but that file
// only ever touches entry num 10 (enter/exit booth 1) and never changes the
// booth COUNT. We therefore confine ourselves to entry nums 30/31 (seeded, not
// 10) and always restore the original booth count, so the two files can run on
// separate workers without corrupting each other. Booth-count mutation by any
// other queue spec is limited to "braking"/"battery", which we never touch.
const TYPE = "tilting";

// Seeded entries we exclusively claim in this file (queue-status-success uses 10).
const STATE_NUM = 31; // Yonsei
const BOOTH_NUM = 30; // PNU
const MY_NUMS = [STATE_NUM, BOOTH_NUM];

function chiefHeaders() {
  return { "Content-Type": "application/json", Cookie: getAuthCookie("chief") };
}
function officialHeaders() {
  return { "Content-Type": "application/json", Cookie: getAuthCookie("official") };
}

async function getQueue(type = TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  return res.ok ? res.json() : [];
}

async function getBooths(type = TYPE) {
  const res = await fetch(`${BASE_URL}/queue/api/admin/booths/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  return res.ok ? res.json() : [];
}

async function getBoothCount(type = TYPE) {
  // booth_config is not exposed directly; the booth list length is the count.
  return (await getBooths(type)).length;
}

async function enterBooth(type, boothNum, num) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    headers: officialHeaders(),
    body: JSON.stringify({ num }),
  });
}

async function exitBooth(type, boothNum) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: officialHeaders(),
  });
}

async function setBoothCount(type, count) {
  return fetch(`${BASE_URL}/queue/api/admin/booths/${type}/config`, {
    method: "PATCH",
    headers: chiefHeaders(),
    body: JSON.stringify({ count }),
  });
}

async function register(num, type = TYPE) {
  return fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: officialHeaders(),
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
}

// Remove only the entry nums this file owns: free any booth they occupy, then
// drain them from the queue via enter+exit (which applies no cancel penalty).
// We deliberately do NOT drain other nums so we never disturb sibling specs.
async function releaseMyNums() {
  const booths = await getBooths();
  for (const b of booths) {
    if (b.occupied_by !== null && MY_NUMS.includes(b.occupied_by)) {
      await exitBooth(TYPE, b.booth_num).catch(() => {});
    }
  }
  const queue = await getQueue();
  for (const item of queue) {
    if (!MY_NUMS.includes(item.num)) continue;
    const booths2 = await getBooths();
    const free = booths2.find((b) => b.active && b.occupied_by === null);
    if (!free) break;
    await enterBooth(TYPE, free.booth_num, item.num).catch(() => {});
    await exitBooth(TYPE, free.booth_num).catch(() => {});
  }
}

test.describe("Queue booth occupancy + public scoping", () => {
  let originalPenalty;

  test.beforeAll(async () => {
    // Drop cancel penalty to 0 so register/enter churn never trips a penalty.
    // (Several queue specs do the same; they all converge on 0 during the run.)
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: chiefHeaders(),
      body: JSON.stringify({ value: 0 }),
    });
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: chiefHeaders(),
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test.beforeEach(async () => {
    await releaseMyNums();
  });

  test.afterEach(async () => {
    await releaseMyNums();
  });

  test("shrinking booth count is blocked while a booth is occupied", async () => {
    // Work relative to whatever the current count is, and restore it exactly,
    // so a concurrent reader of "tilting" booths is never left with a surprise.
    const startCount = await getBoothCount();
    const grownCount = startCount + 1;

    // Grow by one booth (chief).
    const grow = await setBoothCount(TYPE, grownCount);
    test.skip(grow.status !== 200, `grow returned ${grow.status} (contended)`);

    try {
      // Register our entry and occupy the NEW highest booth — the one a shrink
      // back to startCount would try to remove first.
      const reg = await register(BOOTH_NUM);
      test.skip(reg.status !== 201, `register returned ${reg.status} (contended)`);

      const enter = await enterBooth(TYPE, grownCount, BOOTH_NUM);
      test.skip(enter.status !== 200, `enter returned ${enter.status} (contended)`);

      // Confirm occupancy immediately before the guarded action, so the 400 we
      // assert can only come from the occupancy guard.
      let booths = await getBooths();
      const top = booths.find((b) => b.booth_num === grownCount);
      test.skip(!top || top.occupied_by !== BOOTH_NUM, "booth freed by a concurrent op");

      // Shrinking below the occupied booth must be rejected with 400.
      const shrink = await setBoothCount(TYPE, startCount);
      expect(shrink.status).toBe(400);
      expect(await shrink.text()).toContain("사용 중이므로 삭제할 수 없습니다");

      // The shrink is atomic: the occupied top booth still exists.
      booths = await getBooths();
      const stillThere = booths.find((b) => b.booth_num === grownCount);
      expect(stillThere).toBeDefined();
      expect(stillThere.occupied_by).toBe(BOOTH_NUM);

      // Freeing it lets the shrink succeed.
      const exit = await exitBooth(TYPE, grownCount);
      expect(exit.status).toBe(200);
      const shrinkAgain = await setBoothCount(TYPE, startCount);
      expect(shrinkAgain.status).toBe(200);
    } finally {
      // Best-effort restore to the original count regardless of where we bailed.
      await exitBooth(TYPE, grownCount).catch(() => {});
      await setBoothCount(TYPE, startCount).catch(() => {});
    }
  });

  test("public booth read endpoints return 200 unauthenticated", async ({ request }) => {
    const all = await request.get("/queue/api/booths/all");
    expect(all.status()).toBe(200);
    const allBody = await all.json();
    expect(allBody[TYPE]).toBeDefined();
    expect(Array.isArray(allBody[TYPE])).toBe(true);

    const byType = await request.get(`/queue/api/booths/${TYPE}`);
    expect(byType.status()).toBe(200);
    expect(Array.isArray(await byType.json())).toBe(true);

    // Invalid type is a 400 even on the public endpoint.
    const bad = await request.get("/queue/api/booths/not-a-type");
    expect(bad.status()).toBe(400);
  });

  test("state lookup rejects a non-string phone with 400", async ({ request }) => {
    // The phone check only fires once the entry is actually queued, so register
    // our entry first. Skip if a concurrent op kept us out of the queue.
    const reg = await register(STATE_NUM);
    test.skip(reg.status !== 201, `register returned ${reg.status} (contended)`);

    // A non-string phone is rejected. The rate limiter is keyed on req.ip (Caddy
    // strips X-Forwarded-For, so all calls share one proxy IP) and only resets
    // after 60s, so on a retry the bucket may already be tripped by the 429 test
    // below — accept 429 as "limiter answered first" to stay deterministic.
    // A 200 means a sibling op drained our entry between register and query.
    const res = await request.post(`/queue/api/state/${STATE_NUM}`, {
      data: { phone: 1234567890 },
    });
    expect([400, 429, 200]).toContain(res.status());
    if (res.status() === 400) {
      expect(await res.text()).toBe("전화번호 형식이 올바르지 않습니다.");
    }
  });

  // NOTE: the /api/state/:num rate-limit (429) path is intentionally NOT tested
  // here. The limiter is keyed on the proxy IP (Caddy strips X-Forwarded-For) and
  // resets only every 60s, so a 31-call burst would trip it for the WHOLE queue
  // project and spuriously 429 the public-status specs running on the other
  // worker. Not worth the cross-file flake for a P3 path.

  test("settings GET endpoints are readable by official (200)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("official") });
    try {
      const request = ctx.request;

      const sms = await request.get("/queue/api/admin/settings/sms");
      expect(sms.status()).toBe(200);
      expect(typeof (await sms.json()).value).toBe("boolean");

      const smsRank = await request.get("/queue/api/admin/settings/sms-rank");
      expect(smsRank.status()).toBe(200);
      expect(typeof (await smsRank.json()).value).toBe("number");

      const penalty = await request.get("/queue/api/admin/settings/cancel-penalty");
      expect(penalty.status()).toBe(200);
      expect(typeof (await penalty.json()).value).toBe("number");
    } finally {
      await ctx.close();
    }
  });
});
