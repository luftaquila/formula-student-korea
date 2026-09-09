import { withWirelessClock } from "../../helpers/wireless-clock.mjs";
import { currentCompetitionYear } from "../../../shared/common/competition-year.mjs";
import { test, expect } from "@playwright/test";
import {
  expectSSEEventAfter,
  forceSSEReconnect,
  installSSEEventProbe,
  sseEventCount,
  storageStatePath,
  waitForPageReady,
} from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";
import { healthyWirelessBatch, wirelessBrowserRequest } from "../../helpers/wireless-fixtures.mjs";

const YEAR = currentCompetitionYear();
const EVENT = "E2E-WL-Accel";
const NODE_S = "e2e-acc-s";
const NODE_F = "e2e-acc-f";

// 전체 클라이언트 경로 검증(하드웨어 없이): 서버로 보낸 이벤트가 SSE로 도착해
// 매핑→역할 인덱스→경기 로직→기록 저장(addRecord)까지 이어지는지.
test.describe("Wireless acceleration measurement (client routing)", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    // 이전 실패/재시도에서 남은 같은 계정의 lease와 기록을 권위 API로 정리한다.
    await page.request.delete(`/competition/api/v1/traffic/wireless/lease/${encodeURIComponent("가속")}`).catch(() => {});
    await page.request.post("/competition/api/v1/traffic/wireless/arm", { data: { event_type: "가속", action: "stop" } });
    await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${EVENT}`).catch(() => {});
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const p = await ctx.newPage();
    await p.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${EVENT}`).catch(() => {});
    await p.request.delete(`/competition/api/v1/traffic/wireless/mapping/${NODE_S}`).catch(() => {});
    await p.request.delete(`/competition/api/v1/traffic/wireless/mapping/${NODE_F}`).catch(() => {});
    await p.request.delete(`/competition/api/v1/traffic/wireless/lease/${encodeURIComponent("가속")}`).catch(() => {});
    await ctx.close();
  });

  test("server engine saves and reliably reconnects the matching accel record", async ({ page, browser }) => {
    // 재시도도 별도 센서 이벤트가 되도록 매 실행마다 고유 tick/sequence를 사용한다.
    const wireless = wirelessBrowserRequest(page.request);
    const tickBase = BigInt(Date.now()) * 16000n;
    const finishTick = tickBase + 160000000n;
    const eventSequence = Date.now() % 0x10000;

    // 매핑: 출발=NODE_S, 도착=NODE_F (goto 전에 설정 → init SSE에 포함)
    await page.request.put(`/competition/api/v1/traffic/wireless/mapping/${NODE_S}`, { data: { event_type: "가속", role: "start" } });
    await page.request.put(`/competition/api/v1/traffic/wireless/mapping/${NODE_F}`, { data: { event_type: "가속", role: "finish" } });

    await installSSEEventProbe(page, ["init", "wireless:session"]);
    await page.goto("/traffic/wireless/accel");
    await waitForPageReady(page);
    const observerContext = await browser.newContext({ storageState: storageStatePath("admin") });
    const observerPage = await observerContext.newPage();
    await observerPage.goto("/traffic/wireless/accel");
    await waitForPageReady(observerPage);
    const scoreboardContext = await browser.newContext({ storageState: storageStatePath("admin") });
    const scoreboardPage = await scoreboardContext.newPage();
    await scoreboardPage.goto("/traffic/wireless/scoreboard");
    await waitForPageReady(scoreboardPage);

    // 무선 입력칸(이벤트명·팀)은 lease 보유 컨트롤러만 편집 가능(disabled). 이 페이지는 관찰자라
    // UI로 채우지 않고, 귀속(팀·이벤트명)은 세션 select API로 공유한다(브리지/컨트롤러 시뮬레이션).
    await page.request.post("/competition/api/v1/traffic/wireless/select", {
      data: { event_type: "가속", team: await trafficEntry(1), event_name: EVENT },
    });
    const health = await wireless.post("/competition/api/v1/traffic/wireless/ingest", {
      data: healthyWirelessBatch([NODE_S, NODE_F]),
    });
    expect(health.status()).toBe(200);
    const cookies = (await page.request.storageState()).cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const green = await withWirelessClock({
      url: new URL("/competition/api/v1/traffic/events", page.url()).href, cookie: cookies, tick: tickBase.toString(),
      respond: data => page.request.post("/competition/api/v1/traffic/wireless/clock", { data }),
    }, () => wireless.post("/competition/api/v1/traffic/wireless/arm", {
      data: { event_type: "가속", action: "start", start_tick: tickBase.toString() },
    }));
    expect(green.status()).toBe(200);

    // 클라이언트가 SSE로 green 반영
    await expect(page.locator(".traffic-light.green")).toBeVisible({ timeout: 8000 });
    await scoreboardPage.getByLabel("기록 파일").selectOption(`FSK ${YEAR} ${EVENT}`);

    // 출발은 온라인 상태에서 수신한다.
    const startIngest = await wireless.post("/competition/api/v1/traffic/wireless/ingest", {
      data: { events: [{ master_boot_id: 1, node_id: NODE_S, master_tick: tickBase.toString(), ev_seq: eventSequence, rssi: -60, snr: 9 }] },
    });
    expect(startIngest.status()).toBe(200);
    expect(await startIngest.json()).toMatchObject({ stored: 1, rejected: 0 });
    await expect(page.locator(".records-section .record-card").first().locator(".record-item")).toBeVisible({ timeout: 5000 });
    const scoreboardCurrent = scoreboardPage.getByTestId("current-record-가속");
    await expect(scoreboardCurrent).toHaveAttribute("data-measuring", "true", { timeout: 5000 });
    await expect(scoreboardCurrent).toContainText("서울대학교");
    const liveTimer = scoreboardPage.getByTestId("live-timer-가속");
    await expect(liveTimer).toHaveText(/^\d+\.\d{3}$/);
    await expect(scoreboardCurrent.locator(".record-result")).toHaveText(/^\d+\.\d{3}s$/);
    const initialClock = await liveTimer.innerText();
    await expect.poll(() => liveTimer.innerText()).not.toBe(initialClock);

    // SSE 오류 후 앱이 재연결을 예약한 동안 별도 클라이언트에서 도착과 저장이
    // 완료되는 상황을 재현한다. 브라우저 offline 토글은 열린 EventSource를 실제로
    // 끊는 시점을 보장하지 않으므로 오류 경로를 직접 발생시킨다.
    const initCountBeforeReconnect = await sseEventCount(page, "init");
    await forceSSEReconnect(page);
    const finishIngest = await wireless.post("/competition/api/v1/traffic/wireless/ingest", {
      data: { events: [{ master_boot_id: 1, node_id: NODE_F, master_tick: finishTick.toString(), ev_seq: eventSequence, rssi: -61, snr: 9 }] },
    });
    expect(finishIngest.status()).toBe(200);
    expect(await finishIngest.json()).toMatchObject({ stored: 1, rejected: 0 });

    // 재연결 시 timing event는 backfill되고, records 이벤트는 세션의 정확한 name/rowid로 복구된다.
    await expect.poll(() => sseEventCount(page, "init"), { timeout: 8000 }).toBeGreaterThan(initCountBeforeReconnect);
    await expect(page.locator(".traffic-light.green")).toBeVisible({ timeout: 5000 });

    // 클라이언트는 표시만(서버가 저장) — 측정 기록 섹션 노출
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    const quickEdit = page.locator(".saved-section").getByTestId("record-quick-edit");
    await expect(quickEdit).toBeVisible({ timeout: 5000 });
    const observerQuickEdit = observerPage.locator(".saved-section").getByTestId("record-quick-edit");
    await expect(observerQuickEdit).toBeVisible({ timeout: 5000 });
    await expect(observerPage.locator(".records-section .record-item")).toHaveCount(2);
    await expect(scoreboardCurrent).toHaveAttribute("data-measuring", "false", { timeout: 5000 });
    await expect(scoreboardCurrent).toContainText("10.000");

    // 저장 완료 후 처음 접속하면 과거 원시 센서 이벤트는 없지만, 세션의 정확한 행 식별자로
    // 저장 카드와 결과 요약을 복구해야 한다.
    const lateContext = await browser.newContext({ storageState: storageStatePath("admin") });
    const latePage = await lateContext.newPage();
    await latePage.goto("/traffic/wireless/accel");
    await waitForPageReady(latePage);
    const lateQuickEdit = latePage.locator(".saved-section").getByTestId("record-quick-edit");
    await expect(lateQuickEdit).toBeVisible({ timeout: 5000 });
    await expect(latePage.locator(".saved-section")).toContainText("00:10.000");
    await expect(latePage.locator(".records-section .record-item")).toHaveCount(0);

    // 정지 후에도 저장된 기록의 편집 카드는 유지된다.
    const red = await expectSSEEventAfter(page, "wireless:session", () => page.request.post(
      "/competition/api/v1/traffic/wireless/arm",
      { data: { event_type: "가속", action: "stop" } },
    ));
    expect(red.status()).toBe(200);
    await expect(page.locator(".traffic-light.red")).toBeVisible({ timeout: 5000 });

    const beforeManual = await (await page.request.get(`/competition/api/v1/traffic/records/FSK ${YEAR} ${EVENT}`)).json();
    const engineRecord = beforeManual.find((record) => record.type === "가속" && record.result === 10000);
    expect(engineRecord).toBeTruthy();

    // 같은 팀·종목·결과의 수동 기록을 뒤에 추가해도 현재 런의 편집 rowid가 바뀌면 안 된다.
    const manualResponse = await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: EVENT,
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
          result: 10000,
        },
      },
    });
    const manualRecord = (await manualResponse.json()).record;

    // 서버 엔진이 저장한 행만 즉시 편집된다.
    await page.getByTestId("quick-cones-plus").click();
    await expect(page.getByTestId("quick-cones")).toHaveValue("1");

    // 서버 기록 확인(엔진은 ingest 내 동기 저장; 폴링으로 안전 대기)
    await expect.poll(async () => {
      const res = await page.request.get(`/competition/api/v1/traffic/records/FSK ${YEAR} ${EVENT}`);
      if (res.status() !== 200) return 0;
      const rows = await res.json();
      const engine = rows.find((record) => record.rowid === engineRecord.rowid);
      const manual = rows.find((record) => record.rowid === manualRecord.rowid);
      return { engineCones: engine?.cones, manualCones: manual?.cones };
    }, { timeout: 5000 }).toEqual({ engineCones: 1, manualCones: 0 });

    await page.getByRole("button", { name: "제어", exact: true }).click();
    await expect(page.getByRole("button", { name: "제어 해제", exact: true })).toBeVisible();
    // Delay the HTTP response until the committed reset has already arrived over SSE.
    let accepted;
    const committed = new Promise(resolve => { accepted = resolve; });
    let release;
    const responseGate = new Promise(resolve => { release = resolve; });
    const routePattern = "**/competition/api/v1/traffic/wireless/arm";
    await page.route(routePattern, async route => {
      if (route.request().postDataJSON()?.action !== "reset") return route.continue();
      const response = await route.fetch();
      accepted();
      await responseGate;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "초기화", exact: true }).click();
    await committed;
    await expect(observerQuickEdit).not.toBeVisible();
    await expect(lateQuickEdit).not.toBeVisible();
    release();
    await expect(quickEdit).not.toBeVisible();
    await expect(page.getByRole("button", { name: "초기화", exact: true })).toBeDisabled();
    await expect(observerPage.locator(".clock")).toHaveText("00:00.000");
    const resetState = await (await page.request.get("/competition/api/v1/traffic/wireless/state")).json();
    expect(resetState.sessions.find(session => session.event_type === "가속").run_id).toBeNull();
    await page.unroute(routePattern);
    await lateContext.close();
    await observerContext.close();
    await scoreboardContext.close();
    await page.request.delete(`/competition/api/v1/traffic/wireless/lease/${encodeURIComponent("가속")}`);
    await page.reload();
    await waitForPageReady(page);
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();
  });
});
