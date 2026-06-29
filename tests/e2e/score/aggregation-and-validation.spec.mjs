import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// score routes require the admin role (see score/index.mjs authRoleFn).
//
// Scope: ONLY input-validation rejections. Every request here sends out-of-range
// or malformed data and asserts a 400 — the write is rejected, so NOTHING is
// persisted and these tests never touch the shared (year, event_type) penalty /
// setting / endurance rows. That isolation matters: penalty-adjusted best-record
// selection and the endurance composite formula are state-mutating and are
// already covered by calculation.spec / endurance(-realtime).spec; reproducing
// them here would write current-year shared rows and flake those specs (which
// run concurrently in the same shard). Rules verified against score/index.mjs.
const YEAR = new Date().getFullYear();
const TEAM = 32; // 중앙대학교 (seeded); only ever used in payloads that 400.

test.describe("Score write validation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("penalty write rejects negative cone_penalty (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: -1, oc_penalty: 0, start_delay: 0 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("음수");
  });

  test("penalty write rejects negative oc_penalty (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/penalty", {
      data: { year: YEAR, event_type: "가속", cone_penalty: 0, oc_penalty: -5, start_delay: 0 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("음수");
  });

  test("penalty write rejects bad year below 2000 (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/penalty", {
      data: { year: 1999, event_type: "가속", cone_penalty: 1, oc_penalty: 0, start_delay: 0 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("연도");
  });

  test("penalty write rejects bad year above 2099 (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/penalty", {
      data: { year: 2100, event_type: "가속", cone_penalty: 1, oc_penalty: 0, start_delay: 0 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("연도");
  });

  test("setting write rejects negative value (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/setting", {
      data: { year: YEAR, event_type: "가속", setting_key: "total", value: -100 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("음수");
  });

  test("setting write rejects bad year (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/setting", {
      data: { year: 1000, event_type: "가속", setting_key: "total", value: 100 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("연도");
  });

  test("manual write rejects bad year (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/manual", {
      data: { year: 3000, team_num: TEAM, score_type: "report", value: 50 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("연도");
  });

  test("endurance write rejects unknown field (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: TEAM, field: "not_a_real_field", value: 1 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("허용되지 않는 필드");
  });

  test("endurance write rejects invalid status value (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: TEAM, field: "status", value: "DNX" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("상태값");
  });

  test("endurance write rejects negative numeric field (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/endurance", {
      data: { year: YEAR, team_num: TEAM, field: "driver1_time", value: -1 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("음수");
  });

  test("endurance write rejects bad year (400)", async ({ page }) => {
    const res = await page.request.put("/score/api/score/endurance", {
      data: { year: 1999, team_num: TEAM, field: "driver1_time", value: 1000 },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("연도");
  });
});
