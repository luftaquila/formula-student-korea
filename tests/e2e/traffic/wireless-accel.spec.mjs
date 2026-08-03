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

  test("server engine saves and reliably reconnects the matching accel record", async ({ page, browser }) => {
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

    // 출발은 온라인 상태에서 수신한다.
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_S, master_tick: "1600000000", ev_seq: 1, rssi: -60, snr: 9 }] },
    });
    await expect(page.locator(".records-section .record-card").first().locator(".record-item")).toBeVisible({ timeout: 5000 });

    // SSE가 끊긴 동안 별도 클라이언트에서 도착과 저장이 완료되는 상황을 재현한다.
    await page.context().setOffline(true);
    const ingestContext = await browser.newContext({ storageState: storageStatePath("admin") });
    const ingestPage = await ingestContext.newPage();
    await ingestPage.request.post("/traffic/api/wireless/ingest", {
      data: { events: [{ node_id: NODE_F, master_tick: "1600160000", ev_seq: 1, rssi: -61, snr: 9 }] },
    });
    await ingestContext.close();
    await page.context().setOffline(false);

    // 재연결 시 timing event는 backfill되고, records 이벤트는 세션의 정확한 name/rowid로 복구된다.
    await expect(page.locator(".traffic-light.green")).toBeVisible({ timeout: 5000 });

    // 클라이언트는 표시만(서버가 저장) — 측정 기록 섹션 노출
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    const quickEdit = page.locator(".saved-section").getByTestId("record-quick-edit");
    await expect(quickEdit).toBeVisible({ timeout: 5000 });

    // 도착 후 적색등으로 전환되어도 현재 런의 편집 카드는 유지된다.
    await page.request.post("/traffic/api/wireless/light", { data: { color: "red" } });
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });

    const beforeManual = await (await page.request.get(`/traffic/api/records/FSK ${YEAR} ${EVENT}`)).json();
    const engineRecord = beforeManual.find((record) => record.type === "가속" && record.result === 10);
    expect(engineRecord).toBeTruthy();

    // 같은 팀·종목·결과의 수동 기록을 뒤에 추가해도 현재 런의 편집 rowid가 바뀌면 안 된다.
    const manualResponse = await page.request.post("/traffic/api/records", {
      data: {
        name: EVENT,
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "E2E-Univ", team: "E2E-Team" },
          result: 10,
        },
      },
    });
    const manualRecord = (await manualResponse.json()).record;

    // 서버 엔진이 저장한 행만 즉시 편집된다.
    await page.getByTestId("quick-cones-plus").click();
    await expect(page.getByTestId("quick-cones")).toHaveValue("1");

    // 서버 기록 확인(엔진은 ingest 내 동기 저장; 폴링으로 안전 대기)
    await expect.poll(async () => {
      const res = await page.request.get(`/traffic/api/records/FSK ${YEAR} ${EVENT}`);
      if (res.status() !== 200) return 0;
      const rows = await res.json();
      const engine = rows.find((record) => record.rowid === engineRecord.rowid);
      const manual = rows.find((record) => record.rowid === manualRecord.rowid);
      return { engineCones: engine?.cones, manualCones: manual?.cones };
    }, { timeout: 5000 }).toEqual({ engineCones: 1, manualCones: 0 });

    // OFF 요청이 실패해 서버 세션이 red인 채라면 낙관적 grey 상태에서도 편집 카드는 유지된다.
    await page.request.put("/traffic/api/wireless/physical-event", { data: { event_type: null } });
    await page.getByRole("button", { name: "제어", exact: true }).click();
    await expect(page.getByRole("button", { name: "제어 해제", exact: true })).toBeVisible({ timeout: 5000 });
    await page.route("**/traffic/api/wireless/arm", async (route) => {
      const body = route.request().postDataJSON();
      if (body?.action === "off") await route.fulfill({ status: 503, body: "OFF failed" });
      else await route.continue();
    });
    await page.getByRole("button", { name: "OFF", exact: true }).click();
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });
    await expect(quickEdit).toBeVisible();

    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "OFF", exact: true }).click();
    await expect(page.locator(".traffic-light.grey")).toBeVisible({ timeout: 5000 });
    await expect(quickEdit).toBeVisible();

    // 같은 종료 런에서 색만 다시 red로 바뀌어도 카드는 유지되지만 런 수신은 다시 열리지 않는다.
    await page.getByRole("button", { name: "적색등", exact: true }).click();
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });
    await expect(quickEdit).toBeVisible();

    // 명시적 초기화가 확정되면 카드를 제거하고, 같은 종료 run_id의 red로 되살아나지 않는다.
    await page.getByRole("button", { name: "초기화", exact: true }).click();
    await expect(page.locator(".traffic-light.grey")).toBeVisible({ timeout: 5000 });
    await expect(quickEdit).not.toBeVisible();
    await page.getByRole("button", { name: "적색등", exact: true }).click();
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });
    await expect(quickEdit).not.toBeVisible();
    await page.getByRole("button", { name: "제어 해제", exact: true }).click();
  });
});
