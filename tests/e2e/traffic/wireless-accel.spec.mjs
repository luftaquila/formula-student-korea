import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

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

  test("routes mapped sensor events into a saved accel record", async ({ page }) => {
    // 매핑: 출발=NODE_S, 도착=NODE_F (goto 전에 설정 → init SSE에 포함)
    await page.request.put(`/traffic/api/wireless/mapping/${NODE_S}`, { data: { event_type: "가속", role: "start" } });
    await page.request.put(`/traffic/api/wireless/mapping/${NODE_F}`, { data: { event_type: "가속", role: "finish" } });

    await page.goto("/traffic/wireless/accel");
    await waitForPageReady(page);

    // 경기 설정 (무선 모드는 유선 AccelView를 그대로 재사용 → 동일 셀렉터)
    await page.locator('.form-input[type="text"]').fill(EVENT);
    await page.locator("select.form-input").selectOption("1");

    // 가속을 물리 신호등 경기로 지정 + green (브리지 시리얼 대신 서버 API로 동일 상태)
    await page.request.put("/traffic/api/wireless/physical-event", { data: { event_type: "가속" } });
    await page.request.post("/traffic/api/wireless/light", { data: { color: "green", green_tick: "16000000" } });

    // 클라이언트가 SSE로 green 반영
    await expect(page.locator(".traffic-light.green")).toBeVisible({ timeout: 8000 });

    // 출발 이벤트 → 도착 이벤트. 도착 시 기록 저장(POST /api/records) 발생.
    const saved = page.waitForResponse(
      (r) => r.url().includes("/api/records") && r.request().method() === "POST" && r.status() === 201,
    );
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_S, master_tick: "1600000000", ev_seq: 1, rssi: -60, snr: 9 }] },
    });
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_F, master_tick: "1600160000", ev_seq: 1, rssi: -61, snr: 9 }] },
    });
    await saved;

    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expectNotification(page, "success", "기록 저장");

    // 서버 기록 확인
    const res = await page.request.get(`/traffic/api/records/FSK ${YEAR} ${EVENT}`);
    const rows = await res.json();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.type === "가속" && r.result === 10)).toBeTruthy();
  });
});
