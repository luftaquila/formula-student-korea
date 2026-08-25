import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

// 서버 권위 기록 엔진(traffic/index.mjs)의 무선 ingest 계약 검증. 하드웨어 없이 ingest로 직접 구동
// (wireless-accel.spec.mjs와 동일 계약: events:[{ node_id, master_tick, ev_seq, rssi, snr }]).
// 모든 무선 쓰기는 admin (authRoleFn: /api/* → "admin").
const WL_TICKS_PER_MS = 16000; // index.mjs WL_TICKS_PER_MS
const ms = (t) => String(t * WL_TICKS_PER_MS); // ms → tick 문자열(64-bit라 문자열)

test.describe("Wireless record engine (ingest contract)", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("endurance multi-lap appends to a single record and broadcasts updates", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await ctx.newPage();

    const stamp = Date.now();
    const NODE = `e2e-end-${stamp}`;
    const EVENT = `E2E-WL-Endurance-${stamp}`;
    const RECORD = `FSK ${currentCompetitionYear()} ${EVENT}`;
    const TEAM = await trafficEntry(1);

    try {
      await page.request.delete(`/competition/api/v1/traffic/wireless/lease/${encodeURIComponent("내구")}`).catch(() => {});
      await page.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: null } });
      // 내구는 단일 센서 멀티랩(role=start). 매핑 등록.
      const mapRes = await page.request.put(`/competition/api/v1/traffic/wireless/mapping/${NODE}`, {
        data: { event_type: "내구", role: "start" },
      });
      expect(mapRes.status()).toBe(200);

      // bind-at-arm: arm green 본문에 team·event_name을 실어 귀속을 고정(엔진이 run.bound 사용).
      const armRes = await page.request.post("/competition/api/v1/traffic/wireless/arm", {
        data: { event_type: "내구", action: "green", green_tick: ms(0), team: TEAM, event_name: EVENT },
      });
      expect(armRes.status()).toBe(200);
      expect((await armRes.json()).armed).toBe(true);

      // 첫 통과 = t0(출발선, 기록 없음). 이후 통과마다 1랩이 기록 1건에 누적된다.
      // t0 @ 0ms, lap1 끝 @ 5000ms(랩=5000), lap2 끝 @ 12000ms(랩=7000).
      // ev_seq/master_tick으로 멱등. 디바운스(기본 300ms)보다 큰 간격이라 모두 수용.
      const ingest = (seq, atMs) => page.request.post("/competition/api/v1/traffic/wireless/ingest", {
        data: { events: [{ node_id: NODE, master_tick: ms(atMs), ev_seq: seq, rssi: -60, snr: 9 }] },
      });

      let r = await ingest(1, 0);      // t0
      expect(r.status()).toBe(200);
      r = await ingest(2, 5000);       // lap1 = 5000ms → INSERT
      expect(r.status()).toBe(200);

      // 첫 랩 후 기록 1건이 생긴다(type=내구). 폴링으로 엔진 동기 저장 대기.
      await expect.poll(async () => {
        const res = await page.request.get(`/competition/api/v1/traffic/records/${RECORD}`);
        if (res.status() !== 200) return null;
        const rows = (await res.json()).filter((row) => row.type === "내구");
        return rows.length;
      }, { timeout: 8000 }).toBe(1);

      // 1랩 시점 result(총합)와 detail(랩 1개).
      const afterLap1 = await (await page.request.get(`/competition/api/v1/traffic/records/${RECORD}`)).json();
      const row1 = afterLap1.find((row) => row.type === "내구");
      expect(row1.result).toBe(5000);                 // 총합 = 5000ms
      expect(row1.detail).toBe("00:05.000");           // 랩 1개(formatLapMs: MM:SS.mmm)

      // 첫 INSERT가 끝난 뒤 화면을 열어도 현재 arm 이후의 행을 조회해 후처리 카드를 복구한다.
      await page.goto("/traffic/wireless/endurance");
      await waitForPageReady(page);
      await expect(page.getByTestId("record-quick-edit")).toBeVisible({ timeout: 8000 });
      await expect(page.getByText("저장된 기록 후처리", { exact: true })).toBeVisible();

      r = await ingest(3, 12000);      // lap2 = 7000ms → 같은 행 UPDATE
      expect(r.status()).toBe(200);

      // 같은 단일 기록에 누적: 행 수는 그대로 1건, 총합·랩 목록이 갱신된다.
      await expect.poll(async () => {
        const res = await page.request.get(`/competition/api/v1/traffic/records/${RECORD}`);
        if (res.status() !== 200) return null;
        const rows = (await res.json()).filter((row) => row.type === "내구");
        if (rows.length !== 1) return `rows=${rows.length}`;
        return rows[0].result;
      }, { timeout: 8000 }).toBe(12000); // 5000 + 7000

      const afterLap2 = await (await page.request.get(`/competition/api/v1/traffic/records/${RECORD}`)).json();
      const enduranceRows = afterLap2.filter((row) => row.type === "내구");
      expect(enduranceRows.length).toBe(1);            // 멀티랩이 1건에 누적(다중 행 아님)
      expect(enduranceRows[0].detail).toBe("00:05.000 / 00:07.000");

      // 저장 이후 화면을 연 클라이언트에는 로컬 랩 배열이 없더라도, 복구된 저장 행을 초기화할 수 있다.
      await page.request.post("/competition/api/v1/traffic/wireless/arm", {
        data: { event_type: "내구", action: "off" },
      });
      await expect(page.locator(".traffic-light.grey")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("record-quick-edit")).toBeVisible();
      await page.getByRole("button", { name: "제어", exact: true }).click();
      await expect(page.getByRole("button", { name: "제어 해제", exact: true })).toBeVisible({ timeout: 5000 });
      const resetButton = page.getByRole("button", { name: "초기화", exact: true });
      await expect(resetButton).toBeEnabled();
      await resetButton.click();
      await expect(page.getByTestId("record-quick-edit")).not.toBeVisible({ timeout: 5000 });
      const resetState = await (await page.request.get("/competition/api/v1/traffic/wireless/state")).json();
      const resetSession = resetState.sessions.find((session) => session.event_type === "내구");
      expect(resetSession.run_id).toBeNull();
      expect(resetSession.saved_record_name).toBeNull();
      expect(resetSession.saved_record_rowid).toBeNull();
    } finally {
      await page.request.post("/competition/api/v1/traffic/wireless/arm", { data: { event_type: "내구", action: "off" } }).catch(() => {});
      await page.request.delete(`/competition/api/v1/traffic/wireless/lease/${encodeURIComponent("내구")}`).catch(() => {});
      await page.request.delete(`/competition/api/v1/traffic/records/${RECORD}`).catch(() => {});
      await page.request.delete(`/competition/api/v1/traffic/wireless/mapping/${NODE}`).catch(() => {});
      await ctx.close();
    }
  });

  test("ingest is idempotent for the same (node_id, ev_seq, master_tick)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await ctx.newPage();
    const NODE = `e2e-idem-${Date.now()}`;

    try {
      const event = { node_id: NODE, master_tick: ms(1000), ev_seq: 1, rssi: -55, snr: 8 };

      // 첫 ingest: 저장됨.
      const first = await page.request.post("/competition/api/v1/traffic/wireless/ingest", { data: { events: [event] } });
      expect(first.status()).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.stored).toBe(1);
      expect(firstBody.deduped).toBe(0);

      // 동일 (node_id, ev_seq, master_tick) 재전송: dedup → 저장 0, deduped 1.
      const second = await page.request.post("/competition/api/v1/traffic/wireless/ingest", { data: { events: [event] } });
      expect(second.status()).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.stored).toBe(0);
      expect(secondBody.deduped).toBe(1);
    } finally {
      // raw 이벤트는 정리 API가 없어(보존 정책상 트림만) 그대로 둔다 — 유니크 node_id라 격리됨.
      await ctx.close();
    }
  });

  test("ingest rejects bad/missing fields per-event without failing the whole batch", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await ctx.newPage();
    const GOOD = `e2e-good-${Date.now()}`;

    try {
      // 한 배치에 정상 1건 + 잘못된 node_id 1건(공백은 validateNodeId 실패) + master_tick 누락 1건.
      const batch = {
        events: [
          { node_id: GOOD, master_tick: ms(2000), ev_seq: 1, rssi: -60, snr: 9 }, // 정상
          { node_id: "bad id with spaces", master_tick: ms(2000), ev_seq: 2 },     // node_id 거부
          { node_id: `e2e-nomt-${Date.now()}`, ev_seq: 3 },                         // master_tick 누락 거부
        ],
      };
      const res = await page.request.post("/competition/api/v1/traffic/wireless/ingest", { data: batch });
      expect(res.status()).toBe(200); // 부분 거부여도 배치 전체는 실패하지 않음.
      const body = await res.json();
      expect(body.stored).toBe(1);    // 정상 1건은 저장
      expect(body.rejected).toBe(2);  // 잘못된 2건은 거부
    } finally {
      await ctx.close();
    }
  });

  test("lease claims exclusively; a different controller gets 409; admin can force-release", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await ctx.newPage();
    // "내구"를 사용: 다른 spec 파일은 "내구"를 건드리지 않고(같은 파일의 endurance 테스트는 직렬 실행),
    // lease 보유가 다른 종목(가속/스키드패드/오토크로스)의 병렬 select/arm을 409로 막지 않게 격리.
    // 각 lease는 X-Session-Id로 컨트롤러를 구분(wirelessActor: email#sid).
    const EVENT = "내구";
    const PATH = `/competition/api/v1/traffic/wireless/lease/${encodeURIComponent(EVENT)}`;
    const sidA = `e2e-sidA-${Date.now()}`;
    const sidB = `e2e-sidB-${Date.now()}`;

    try {
      // 시작 상태 정리(이전 잔여 lease 강제 회수 — admin 권한).
      await page.request.delete(PATH).catch(() => {});

      // 컨트롤러 A가 점유.
      const claimA = await page.request.post(PATH, { headers: { "X-Session-Id": sidA } });
      expect(claimA.status()).toBe(200);
      const sessA = await claimA.json();
      expect(sessA.controller).toBeTruthy();

      // 다른 세션(B)이 점유 시도 → 409(다른 사용자가 제어 중).
      const claimB = await page.request.post(PATH, { headers: { "X-Session-Id": sidB } });
      expect(claimB.status()).toBe(409);
      expect(await claimB.text()).toContain("제어 중");

      // 같은 세션(A) 재요청은 heartbeat → 200(점유 연장).
      const heartbeatA = await page.request.post(PATH, { headers: { "X-Session-Id": sidA } });
      expect(heartbeatA.status()).toBe(200);

      // admin 강제 해제(보유자 무관) → controller 비워짐.
      const release = await page.request.delete(PATH);
      expect(release.status()).toBe(200);
      const released = await release.json();
      expect(released.controller).toBeNull();

      // 해제 후 B가 점유 가능 → 200.
      const claimBAfter = await page.request.post(PATH, { headers: { "X-Session-Id": sidB } });
      expect(claimBAfter.status()).toBe(200);
    } finally {
      await page.request.delete(PATH).catch(() => {});
      await ctx.close();
    }
  });
});
