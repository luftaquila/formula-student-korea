import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const EVENT = "E2E-WL-Accel";
const NODE_S = "e2e-acc-s";
const NODE_F = "e2e-acc-f";

// 전체 클라이언트 경로 검증(하드웨어 없이): 서버로 보낸 이벤트가 SSE로 도착해
// 매핑→역할 인덱스→경기 로직→기록 저장(addRecord)까지 이어지는지.
test.describe("Wireless acceleration measurement (client routing)", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const p = await ctx.newPage();
    await p.request.delete(`/traffic/api/records/FSK ${YEAR} ${EVENT}`).catch(() => {});
    await p.request.delete(`/traffic/api/wireless/mapping/${NODE_S}`).catch(() => {});
    await p.request.delete(`/traffic/api/wireless/mapping/${NODE_F}`).catch(() => {});
    await p.request.put("/traffic/api/wireless/physical-event", { data: { event_type: null } }).catch(() => {});
    await ctx.close();
  });

  test("server engine saves an accel record from mapped sensor events", async ({ page }) => {
    // 매핑: 출발=NODE_S, 도착=NODE_F (goto 전에 설정 → init SSE에 포함)
    await page.request.put(`/traffic/api/wireless/mapping/${NODE_S}`, { data: { event_type: "가속", role: "start" } });
    await page.request.put(`/traffic/api/wireless/mapping/${NODE_F}`, { data: { event_type: "가속", role: "finish" } });

    await page.goto("/traffic/wireless/accel");
    await waitForPageReady(page);

    // 무선 입력칸(이벤트명·팀)은 lease 보유 컨트롤러만 편집 가능(disabled). 이 페이지는 관찰자라
    // UI로 채우지 않고, 귀속(팀·이벤트명)은 세션 select API로 공유한다(브리지/컨트롤러 시뮬레이션).
    await page.request.post("/traffic/api/wireless/select", {
      data: { event_type: "가속", team: { num: 1, univ: "E2E-Univ", team: "E2E-Team" }, event_name: EVENT },
    });
    // 가속을 물리 경기로 지정 + green(=arm). 서버가 세션에 arm 미러.
    await page.request.put("/traffic/api/wireless/physical-event", { data: { event_type: "가속" } });
    await page.request.post("/traffic/api/wireless/light", { data: { color: "green", green_tick: "16000000" } });

    // 클라이언트가 SSE로 green 반영
    await expect(page.locator(".traffic-light.green")).toBeVisible({ timeout: 8000 });

    // 출발 → 도착. 서버 기록 엔진이 ingest에서 직접 저장(클라 저장 아님).
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_S, master_tick: "1600000000", ev_seq: 1, rssi: -60, snr: 9 }] },
    });
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_F, master_tick: "1600160000", ev_seq: 1, rssi: -61, snr: 9 }] },
    });

    // 도착 직후 적색등으로 전환돼 active=false가 먼저 반영되어도 저장 행을 놓치지 않는다.
    await page.request.post("/traffic/api/wireless/light", { data: { color: "red" } });
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });

    // 클라이언트는 표시만(서버가 저장) — 측정 기록 섹션 노출
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    const quickEdit = page.getByTestId("record-quick-edit");
    await expect(quickEdit).toBeVisible({ timeout: 5000 });

    // 서버 엔진이 저장한 행도 같은 즉시 편집 UI에 연결된다.
    await page.getByTestId("quick-cones-plus").click();
    await expect(page.getByTestId("quick-cones")).toHaveValue("1");

    // 서버 기록 확인(엔진은 ingest 내 동기 저장; 폴링으로 안전 대기)
    await expect.poll(async () => {
      const res = await page.request.get(`/traffic/api/records/FSK ${YEAR} ${EVENT}`);
      if (res.status() !== 200) return 0;
      const rows = await res.json();
      return rows.filter((r) => r.type === "가속" && r.result === 10 && r.cones === 1).length;
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  });
});
