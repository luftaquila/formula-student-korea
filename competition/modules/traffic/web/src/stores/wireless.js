import { createWirelessEventBuffer } from "@lib/wireless-event-buffer.mjs";
import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useNotification } from "@shared/browser/useNotification.js";
import { msToClockStr } from "./serial";
import {
  ingestWireless,
  reportWirelessClock,
  reportBridgeOffline,
  putWirelessDebounce,
  armWirelessEvent,
  claimWirelessLease,
  releaseWirelessLease,
  fetchServerTime,
  selectWirelessEvent,
  statusWirelessEvent,
} from "../composables/useApi";
import {
  wirelessLight,
  wirelessMapping,
  wirelessTelemetry,
  wirelessBridge,
  wirelessSessions,
  onWirelessEvent,
  onWirelessCommand,
  applyWirelessSession,
} from "../composables/useSSE";
import { WIRELESS_EVENTS, EVENT_TYPE, roleToSensor } from "../composables/useEventTiming";
import { acceptSensorTick } from "../composables/sensorDebounce";
import { ruleFor, shouldLatchStart, shouldIgnore, lapTime } from "@lib/event-timing.mjs";
import {
  applyResetMarker,
  createResetMarker,
  resetMarkerResolved,
} from "@lib/wireless-reset.mjs";

const TICKS_PER_MS = 16000;
const DEFAULT_DEBOUNCE_MS = 300;
const TYPE_TO_KEY = Object.fromEntries(Object.entries(EVENT_TYPE).map(([k, v]) => [v, k]));
// Keep fractional milliseconds until an interval is complete. Rounding absolute
// endpoints independently can move a single interval by a full millisecond.
const tickToMs = (t) => Number(t || 0) / TICKS_PER_MS;

function makeSlot() {
  return {
    green: { active: false, tick: null, timestamp: null },
    start: { tick: null, timestamp: null, serverMs: null },
    records: [],
    clockDisplay: "00:00.000",
    clockRAF: null,
    lastSensorTrigger: {},
    light: "grey",
  };
}

export const useWirelessStore = defineStore("wireless", () => {
  const { notyf } = useNotification();

  const role = ref("client");
  const bridgeIsSelf = ref(false);
  const serialConnected = ref(false);

  // 경기별 타이밍 상태(유선 serial store의 flat 상태를 경기별로 namespace)
  const timing = reactive({});
  for (const k of WIRELESS_EVENTS) timing[k] = makeSlot();
  const appliedRunIds = new Map();
  const callbacks = {}; // mode -> 뷰의 onSensor (유선 뷰와 동일 로직)

  // SSE 실시간 상태
  const light = wirelessLight;
  const mapping = wirelessMapping;
  const telemetry = wirelessTelemetry;
  const bridge = wirelessBridge;
  const sessions = wirelessSessions; // event_type -> 세션(arm/결과/lease) — 서버 권위
  // RESET 응답 뒤 늦은 이전 런 SSE가 화면을 되살리지 않도록 새 런까지 유지한다.
  const resetMarkers = reactive(new Map());

  function effectiveSessionFor(mode) {
    const eventType = EVENT_TYPE[mode];
    const resetApplied = applyResetMarker(
      sessions.value?.[eventType] || null,
      resetMarkers.get(eventType),
    );
    return resetApplied;
  }

  function reconcileResetMarkers() {
    for (const [eventType, marker] of resetMarkers) {
      if (resetMarkerResolved(marker, sessions.value?.[eventType])) {
        resetMarkers.delete(eventType);
      }
    }
  }

  // 센서 디바운스 창(ms). 서버(wireless_light)에 저장돼 wireless:light로 공유. 기본 300ms.
  const debounceMs = computed(() => {
    const v = light.value?.debounce_ms;
    return Number.isFinite(v) ? v : DEFAULT_DEBOUNCE_MS;
  });
  async function setDebounceMs(ms) {
    try { await putWirelessDebounce(ms); }
    catch (e) { notyf.error(e.message); }
  }

  function lightColorFor(mode) { return timing[mode].light; }

  // controller 식별자는 email#sessionId(같은 계정의 다른 탭 구분용). 표시는 email만.
  const controllerLabel = (c) => (c ? String(c).split("#")[0] : c);
  // 경기별 세션의 controller(lease 보유자). 표시용(세션 접미 #sid 제거).
  function controllerFor(mode) {
    return controllerLabel(sessions.value?.[EVENT_TYPE[mode]]?.controller) || null;
  }

  // 공유 클럭: 서버 시각과 내 시계의 오프셋(ms). 출발이벤트 server_time을 이 오프셋으로 보정해
  // 전 클라가 동일한 경과시간을 표시한다(표시용; 기록값은 master-tick으로 정확).
  let serverOffsetMs = 0;
  async function syncServerTime() {
    try {
      const t0 = Date.now();
      const { now } = await fetchServerTime();
      const t1 = Date.now();
      if (Number.isFinite(now)) serverOffsetMs = now - (t0 + t1) / 2;
    } catch { /* 이전 오프셋 유지 */ }
  }
  syncServerTime();
  // 서버 보정 현재시각(ms). last_seen 등 서버 시계 기준 값과의 경과를 계산할 때 사용 —
  // 클라 벽시계를 그대로 쓰면 PC 시계 오차만큼 진단(나이·링크상태)이 틀어진다.
  function serverNow() { return Date.now() + serverOffsetMs; }

  /* ── 클럭 ──────────────────────────────────────────────────────── */
  function startClock(slot) {
    stopClock(slot);
    const tick = () => {
      if (slot.start.serverMs != null) {
        slot.clockDisplay = msToClockStr(Date.now() + serverOffsetMs - slot.start.serverMs);
      } else if (slot.start.timestamp) {
        slot.clockDisplay = msToClockStr(Date.now() - slot.start.timestamp.getTime());
      }
      slot.clockRAF = requestAnimationFrame(tick);
    };
    slot.clockRAF = requestAnimationFrame(tick);
  }
  function stopClock(slot) {
    if (slot.clockRAF) { cancelAnimationFrame(slot.clockRAF); slot.clockRAF = null; }
  }

  /* ── green 적용 ──────────────────────────────────────────────────── */
  function activateGreen(mode, greenTickMs) {
    const slot = timing[mode];
    slot.green = { active: true, tick: greenTickMs, timestamp: new Date() };
    slot.clockDisplay = "00:00.000";
    slot.records = [];
    slot.start = { tick: null, timestamp: null, serverMs: null };
    slot.lastSensorTrigger = {};
    // green = arm일 뿐 t0가 아니다. 전 경기 t0는 출발 센서(routeSensor에서 래치).
  }
  function deactivateGreen(mode) {
    const slot = timing[mode];
    slot.green.active = false;
    stopClock(slot);
  }

  function clearTiming(mode) {
    const slot = timing[mode];
    stopClock(slot);
    slot.clockDisplay = "00:00.000";
    slot.records = [];
    slot.start = { tick: null, timestamp: null, serverMs: null };
    slot.lastSensorTrigger = {};
  }

  const eventBuffer = createWirelessEventBuffer();
  function applySession(s) {
    if (!s) return;
    const mode = TYPE_TO_KEY[s.event_type];
    if (!mode || !timing[mode]) return;
    const slot = timing[mode];
    const previousRunId = appliedRunIds.get(mode);
    const runId = s.run_id ?? null;
    const resetCompleted = previousRunId != null && runId == null;
    appliedRunIds.set(mode, runId);
    slot.light = s.armed ? "green" : s.run_id ? "red" : "grey";
    if (s.armed) {
      const gt = tickToMs(s.start_tick);
      if (!slot.green.active || slot.green.tick !== gt || previousRunId !== runId) activateGreen(mode, gt);
      eventBuffer.replay(s, ev => routeWirelessEvent(ev, s.event_type));
      if (s.finished) { stopClock(slot); if (s.result != null) slot.clockDisplay = msToClockStr(s.result); }
    } else {
      deactivateGreen(mode);
      if (resetCompleted) clearTiming(mode);
    }
  }
  function applyAllSessions() {
    reconcileResetMarkers();
    for (const mode of WIRELESS_EVENTS) applySession(effectiveSessionFor(mode));
  }
  watch(sessions, applyAllSessions, { deep: true });
  applyAllSessions();

  /* ── 센서 라우팅(serial.handleSensorReport와 동일 순서) ───────────── */
  // 디바운스(tick 기준): 한 통과의 다중 엣지(바운스, ~30~150ms)를 접는다. 벽시계가 아니라
  // 이벤트 캡처 시각(tick)으로 비교하므로 버퍼링·지연·재전송·백필로 도착이 흩어져도 안전.
  function routeSensor(mode, sensor, tick, nowMs, serverMs) {
    const slot = timing[mode];
    if (!slot.green.active) return;
    if (!acceptSensorTick(slot.lastSensorTrigger, sensor, tick, debounceMs.value)) return;

    const payload = {
      sensor, tick,
      timestamp: new Date(nowMs),
      greenTick: slot.green.tick,
      startTick: slot.start.tick,
      startTimestamp: slot.start.timestamp,
    };
    try { callbacks[mode]?.(payload); } catch (e) { notyf.error(`기록 처리 실패: ${e.message}`); }

    // 출발 센서에서 t0 래치(accel/autocross/skidpad 모두 센서 1). green은 arm일 뿐.
    const rule = ruleFor(mode);
    if (shouldLatchStart(rule, sensor, !!slot.start.timestamp)) {
      slot.start.tick = tick;
      slot.start.timestamp = new Date(nowMs);
      slot.start.serverMs = serverMs ?? null; // 공유 클럭 앵커(출발이벤트 서버 시각)
      startClock(slot);
    }
    if (shouldIgnore(rule, sensor)) return;
    const time = lapTime(tick, slot.start.tick, slot.green.tick);
    slot.records.push({ sensor, tick, time, timestamp: new Date(nowMs) });
  }

  function handleWirelessEvent(ev) {
    if (ev.flags !== 15) return;
    eventBuffer.add(ev);
    // Apply the session synchronously: Vue's watcher may still be queued when
    // the next SSE edge arrives. Replay only after activateGreen has run.
    applyAllSessions();
  }
  function routeWirelessEvent(ev, eventType) {
    const tick = tickToMs(ev.master_tick);
    const node = String(ev.node_id);
    const nowMs = Date.now();
    // server_time은 UTC(strftime 'now', tz 마커 없음) → Z 부착해 UTC로 파싱. 전 클라 동일 기준.
    const st = ev.server_time;
    const serverMs = st ? Date.parse(st.endsWith("Z") ? st : st + "Z") : null;
    for (const row of mapping.value) {
      if (row.node_id !== node || row.enabled === 0 || row.event_type !== eventType) continue;
      const mode = TYPE_TO_KEY[row.event_type];
      if (!mode) continue;
      routeSensor(mode, roleToSensor(mode, row.role), tick, nowMs, Number.isFinite(serverMs) ? serverMs : null);
    }
  }
  onWirelessEvent(handleWirelessEvent);

  onWirelessCommand((cmd) => {
    if (!bridgeIsSelf.value || !cmd) return;
    if (cmd.action === "clock" && /^[a-f0-9]{32}$/.test(cmd.request_id)) {
      transmitLine(`T ${cmd.request_id}`);
      return;
    }

  });

  /* ── 브리지(시리얼) ───────────────────────────────────────────────── */
  let serialPort = null;
  let serialReader = null;
  let intentionalClose = false; // closeSerial()로 끊는 중인지 — read 루프 종료가 분리인지 구분
  const eventBuf = new Map();
  const telemetryBuf = new Map();
  let flushScheduled = false;
  let flushInFlight = false;
  let hbTimer = null;

  function stateMap(s) { return s === "OK" ? "online" : s === "STALE" ? "degraded" : "lost"; }
  function eventKey(event) { return `${event.master_boot_id}:${event.sensor_boot_id}:${event.node_id}:${event.ev_seq}:${event.master_tick}`; }

  async function flushIngest() {
    if (flushInFlight) return; // 직렬화: 동시 flush로 같은 events 중복 전송/순서 꼬임 방지
    if (!eventBuf.size && !telemetryBuf.size) return;
    flushInFlight = true;
    const events = [...eventBuf.values()];
    for (const event of events) eventBuf.delete(eventKey(event));
    const tel = [...telemetryBuf.values()];
    telemetryBuf.clear();
    try {
      const result = await ingestWireless({ events, telemetry: tel });
      const acknowledged = new Set((result?.acknowledged || []).map(eventKey));
      for (const event of events) {
        if (acknowledged.has(eventKey(event))) {
          // The server has durably inserted or deduplicated this exact tuple.
          // Only now may the master evict it from its RAM delivery queue.
          if (await transmitLine(`C ${event.node_id} ${event.ev_seq} ${event.master_tick} ${event.master_boot_id} ${event.sensor_boot_id}`)) {
            eventBuf.delete(eventKey(event));
          } else {
            eventBuf.set(eventKey(event), event);
          }
        } else {
          eventBuf.set(eventKey(event), event);
        }
      }
      if (result?.rejected) notyf.error(`서버가 무선 이벤트 ${result.rejected}건을 거부했습니다.`);
    } catch (e) {
      // 전송 실패(네트워크 끊김·서버 재배포·503 등) 시 이벤트를 유실하면 안 되므로 버퍼
      // 앞으로 되돌려 다음 flush(≤2s heartbeat)에서 재시도. 텔레메트리는 최신값만 의미
      // 있어 재시도하지 않는다.
      for (const event of events) eventBuf.set(eventKey(event), event);
      notyf.error(`서버 전송 실패(재시도 예정): ${e.message}`);
    } finally {
      flushInFlight = false;
    }
  }
  function scheduleEventFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => { flushScheduled = false; flushIngest(); }, 0);
  }

  function parseLine(line) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) return;
    switch (t[0]) {
      case "E": // E node ev_seq tmaster flags rssi snr master_boot_id
        {
          const event = { node_id: t[1], ev_seq: Number(t[2]), master_tick: t[3], flags: Number(t[4]), rssi: Number(t[5]), snr: Number(t[6]), master_boot_id: Number(t[7]), sensor_boot_id: Number(t[8]), capture_seq: Number(t[9]), end_seq: Number(t[10]), end_tick: t[11], sync_age_ms: Number(t[12]), link_state: "online" };
          eventBuf.set(eventKey(event), event);
        }
        scheduleEventFlush();
        break;
      case "D": // D ... provisioned sync/skew/clock/capture/queue/USB clock health
        telemetryBuf.set(t[1], {
          node_id: t[1], rssi: Number(t[8]), snr: Number(t[9]),
          offset_us: Math.round(Number(t[3]) / 16), skew_ppm: Number(t[4]),
          rx_miss: Number(t[5]), beacon_gap: Number(t[6]),
          // t[7] = 마스터가 이 노드를 마지막으로 들은 뒤 경과(ms). 서버가 절대 "수신" 시각으로 환산.
          last_seen_ms: Number(t[7]),
          latency_ms: Number(t[10]),
          // t[11] = 다이 온도(deci-°C), t[12] = 배터리/충전레일(mV). 마스터(node 0)는 자기 값.
          temp_c10: Number(t[11]), batt_mv: Number(t[12]),
          sec_drop: Number(t[13]), provisioned: Number(t[14]),
          sync_valid: Number(t[15]), skew_valid: Number(t[16]),
          clock_source: t[17] === "XTAL" ? "xtal" : "rc",
          sync_age_ms: Number(t[18]), capture_overflow: Number(t[19]),
          event_drop: Number(t[20]), queue_depth: Number(t[21]),
          queue_overflow: Number(t[22]), usb_ref_valid: Number(t[23]),
          usb_ref_ppm: Number(t[24]), sensor_boot_id: Number(t[25]), master_boot_id: Number(t[26]),
          link_state: stateMap(t[2]),
        });
        break;
      case "T":
        reportWirelessClock({ request_id: t[1], master_tick: t[2], master_boot_id: Number(t[3]) })
          .catch((error) => notyf.error(`마스터 시각 확인 실패: ${error.message}`));
        break;
      case "I": // I FSK-WL <fw> <devid16hex> <freq> <sf> <bw> <ticks> — 마스터 자기 ID (표시 안 함)
        break;
      default: break; // A/X 무시
    }
  }

  let serialWriteChain = Promise.resolve(true);
  function transmitLine(s) {
    const write = async () => {
      if (!serialPort?.writable) return false;
      const writer = serialPort.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(s + "\n"));
        return true;
      }
      catch (e) { notyf.error(`전송 실패: ${e}`); return false; }
      finally { writer.releaseLock(); }
    };
    serialWriteChain = serialWriteChain.then(write, write);
    return serialWriteChain;
  }

  async function bridgeReadLoop() {
    let buffer = "";
    try {
      serialReader = serialPort.readable.getReader();
      while (serialPort && serialPort.readable) {
        const { value, done } = await serialReader.read();
        if (done) break;
        if (value) {
          buffer += new TextDecoder().decode(value);
          let idx;
          while ((idx = buffer.indexOf("\n")) > -1) { parseLine(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
        }
      }
    } catch { /* 디바이스 분리 / 리더 취소 — 아래에서 정리 */ }
    finally { try { serialReader?.releaseLock(); } catch { /* ignore */ } }
    // read 루프가 끝났다 = 시리얼 끊김. 의도적 closeSerial이 아니라면(케이블 분리 등)
    // 즉시 연결 해제 처리해서 UI가 바로 끊김으로 바뀐다(서버 오프라인 보고 포함).
    if (!intentionalClose) {
      notyf.error("마스터 연결이 끊어졌습니다.");
      closeSerial();
    }
  }

  // ── Screen Wake Lock(브리지 견고화) ── 브리지로 동작하는 동안 화면 sleep 방지.
  // Wake Lock은 탭이 hidden되면 자동 해제되므로 visible 복귀 시 재획득.
  let wakeLock = null;
  async function acquireWakeLock() {
    try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }
    catch { /* 권한·정책으로 실패해도 무시(견고화 보조 수단) */ }
  }
  function releaseWakeLock() {
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && bridgeIsSelf.value) acquireWakeLock();
    });
  }
  // 케이블 분리 등 갑작스런 시리얼 끊김은 read 루프가 즉시 못 잡을 수 있어, OS가 보고하는
  // navigator.serial 'disconnect'로도 우리 포트면 바로 정리(경고 + 오프라인 보고).
  if (typeof navigator !== "undefined" && "serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (serialPort && e.target === serialPort) {
        notyf.error("마스터 연결이 끊어졌습니다.");
        closeSerial();
      }
    });
  }

  async function openSerial() {
    if (!("serial" in navigator)) { notyf.error("이 브라우저는 Web Serial을 지원하지 않습니다."); return false; }
    if (bridge.value.online && !bridgeIsSelf.value) { notyf.error("이미 다른 PC가 마스터에 연결되어 있습니다."); return false; }
    try {
      serialPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x1999, usbProductId: 0x0515 }] });
      await serialPort.open({ baudRate: 115200 });
      intentionalClose = false;
      role.value = "bridge";
      bridgeIsSelf.value = true;
      serialConnected.value = true;
      acquireWakeLock(); // 브리지 동작 중 화면 sleep 방지
      transmitLine("?STATUS");
      hbTimer = setInterval(flushIngest, 2000);
      bridgeReadLoop();
      notyf.success("마스터 연결 완료");
      return true;
    } catch (e) { notyf.error(`마스터 연결 실패: ${e}`); return false; }
  }

  async function closeSerial() {
    const wasBridge = bridgeIsSelf.value;
    intentionalClose = true; // read 루프가 이 종료를 분리로 오인하지 않도록
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    try { await serialReader?.cancel(); } catch { /* ignore */ }
    try { await serialPort?.close(); } catch { /* ignore */ }
    serialPort = null; serialReader = null;
    serialConnected.value = false; bridgeIsSelf.value = false; role.value = "client";
    releaseWakeLock();
    // 서버에 즉시 오프라인 보고 → "마스터 연결"이 15s 워치독을 기다리지 않고 바로 풀린다.
    if (wasBridge) reportBridgeOffline().catch(() => {});
  }

  /* ── 경기 제어 (lease 보유자) ─────────────────────────────────────── */
  // 내가 점유한 경기(EVENT_TYPE 값). heartbeat 대상. 보유자만 제어 가능.
  const myLeases = reactive(new Set());
  const myActor = ref(null); // claim 응답에서 학습한 내 식별자(이메일).
  // 제어권 판정은 **서버 세션의 controller** 기준 — wireless:session 브로드캐스트로 즉시 반영되어
  // 서버가 lease를 회수/만료하면 UI가 바로 풀린다(로컬 staleness 제거).
  function holdsLease(mode) {
    const s = sessions.value?.[EVENT_TYPE[mode]];
    return !!myActor.value && !!s && s.controller === myActor.value;
  }
  function requireControl(mode) {
    if (!holdsLease(mode)) { notyf.error("먼저 제어권을 잡으세요(제어 버튼)."); return false; }
    return true;
  }
  let leaseTimer = null;
  function ensureLeaseHeartbeat() {
    if (leaseTimer || myLeases.size === 0) return;
    // TTL 30s → 12s마다 갱신. 갱신 실패(만료 후 타인 점유 등)면 그 경기 점유 해제.
    leaseTimer = setInterval(async () => {
      for (const et of [...myLeases]) {
        try { await claimWirelessLease(et); }
        catch { myLeases.delete(et); notyf.error(`제어권 상실: ${et}`); }
      }
      if (myLeases.size === 0) { clearInterval(leaseTimer); leaseTimer = null; }
    }, 12000);
  }
  // 마스터(브리지) 미연결 경고: 오프라인이면 센서 이벤트가 수신되지 않아 기록이 되지 않는다.
  function warnIfMasterOffline() {
    if (!bridge.value?.online) {
      notyf.open({ type: "warning", message: "마스터 연결 안 됨" });
    }
  }
  async function claimLease(mode) {
    warnIfMasterOffline();
    const et = EVENT_TYPE[mode];
    try {
      const s = await claimWirelessLease(et);
      if (s?.controller) myActor.value = s.controller; // 내 식별자 학습 → holdsLease 판정 기준
      myLeases.add(et);
      ensureLeaseHeartbeat();
    } catch (e) { notyf.error(e.message); }
  }
  async function releaseLease(mode) {
    const et = EVENT_TYPE[mode];
    // 제어권 반납 전, 공유 선택(팀·이벤트명)을 비워 다음 컨트롤러/관찰자가 깨끗한 상태에서
    // 시작하도록 한다. selectWirelessEvent는 lease 보유자만 반영되므로 release보다 먼저,
    // 순차로 호출(release가 먼저 처리되면 선택 비우기가 거부돼 팀이 남는 레이스 방지).
    try { await selectWirelessEvent({ event_type: et, team: null, event_name: null }); }
    catch { /* ignore */ }
    myLeases.delete(et);
    if (myLeases.size === 0 && leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    try { await releaseWirelessLease(et); }
    catch { /* ignore */ }
  }
  // 강제 가로채기: 현재 점유를 회수(서버는 admin 허용)한 뒤 내가 claim. 멈춘 탭이 lease를 쥔 경우.
  async function takeoverLease(mode) {
    warnIfMasterOffline();
    const et = EVENT_TYPE[mode];
    try {
      await releaseWirelessLease(et);
      const s = await claimWirelessLease(et);
      if (s?.controller) myActor.value = s.controller;
      myLeases.add(et);
      ensureLeaseHeartbeat();
    } catch (e) { notyf.error(e.message); }
  }
  // 경기별 필요 역할(센서). 미할당 역할이 있으면 그 구간은 기록되지 않는다.
  const REQUIRED_ROLES = { accel: ["start", "finish"], skidpad: ["start"], autocross: ["start", "finish"], endurance: ["start"] };
  const ROLE_LABEL = { start: "출발", finish: "도착" };
  function missingRoles(mode) {
    const have = new Set(
      mapping.value.filter((m) => m.enabled !== 0 && m.event_type === EVENT_TYPE[mode]).map((m) => m.role),
    );
    return (REQUIRED_ROLES[mode] || []).filter((r) => !have.has(r));
  }

  async function armAction(mode, action) {
    const eventType = EVENT_TYPE[mode];
    const requestedSession = sessions.value?.[eventType];
    const requestedRunId = action === "reset" ? requestedSession?.run_id ?? null : null;
    try {
      const result = await armWirelessEvent({ event_type: eventType, action });
      if (action === "reset") {
        const marker = createResetMarker(sessions.value?.[eventType], result, requestedRunId);
        if (marker) {
          resetMarkers.set(eventType, marker);
          // Map 변경은 sessions watcher를 실행하지 않으므로 응답으로 확정된 완료 상태를
          // 즉시 타이밍 슬롯에도 적용한다. 화면의 session computed도 같은 Map을 추적한다.
          applySession(effectiveSessionFor(mode));
        }
      }
      if (sessions.value?.[eventType] === requestedSession) applyWirelessSession(result);
      applyAllSessions();
      return true;
    } catch (e) {
      notyf.error(e.message);
      return false;
    }
  }
  async function greenFor(mode, team = null, eventName = null) {
    if (!requireControl(mode)) return false;
    warnIfMasterOffline();
    const missing = missingRoles(mode);
    if (missing.length) {
      notyf.open({ type: "warning", message: `센서 미할당: ${missing.map((r) => ROLE_LABEL[r] || r).join(", ")}` });
    }
    // The server obtains a fresh master capture before opening the run.
    // team·event_name을 arm 본문에 실어 bind-at-arm: /select POST와의 도착 순서 레이스와
    // 무관하게 서버가 arm 시점 귀속을 고정한다(서버 엔진이 run.bound로 사용).
    const before = sessions.value?.[EVENT_TYPE[mode]];
    try {
      const session = await armWirelessEvent({ event_type: EVENT_TYPE[mode], action: "start", team: team || null, event_name: eventName || null });
      if (sessions.value?.[EVENT_TYPE[mode]] === before) applyWirelessSession(session);
      applyAllSessions();
      return true;
    } catch (e) {
      notyf.error(e.message);
      return false;
    }
  }
  function redFor(mode) {
    if (!requireControl(mode)) return false;
    return armAction(mode, "stop");
  }
  function offFor(mode) {
    if (!requireControl(mode)) return false;
    return armAction(mode, "stop");
  }
  async function resetFor(mode) {
    if (!holdsLease(mode)) return false;
    return armAction(mode, "reset");
  }

  /* ── 유선 이벤트 뷰 재사용 facade (경기별) ───────────────────────── */
  function sourceFor(mode) {
    const slot = timing[mode];
    return {
      get connected() { return bridgeIsSelf.value; },
      get manualMode() { return false; },
      get isBridge() { return bridgeIsSelf.value; },
      // 제어권: lease 보유자만 제어. 관찰자(미보유)는 read-only.
      get isController() { return holdsLease(mode); },
      get controller() { return controllerLabel(sessions.value?.[EVENT_TYPE[mode]]?.controller) || null; },
      // 경기 세션(서버 권위 선택·arm). 관찰자 뷰가 컨트롤러의 팀·이벤트명을 미러하는 데 사용.
      get session() { return effectiveSessionFor(mode); },
      get green() { return slot.green; },
      get records() { return slot.records; },
      get clockDisplay() { return slot.clockDisplay; },
      get lightColor() { return lightColorFor(mode); },
      setMode: (_m, cb) => { callbacks[mode] = cb; },
      connect: () => openSerial(),
      claimLease: () => claimLease(mode),
      releaseLease: () => releaseLease(mode),
      takeoverLease: () => takeoverLease(mode),
      sendGreen: (team, eventName) => greenFor(mode, team, eventName),
      sendRed: () => redFor(mode),
      sendOff: () => offFor(mode),
      reset: () => resetFor(mode),
      // 선택(팀·이벤트명) 공유 — lease 보유자만. 서버 기록 엔진이 이 값으로 귀속.
      selectEvent: (team, eventName) => {
        if (!holdsLease(mode)) return;
        selectWirelessEvent({ event_type: EVENT_TYPE[mode], team: team || null, event_name: eventName || null }).catch(() => {});
      },
      // 판정은 서버가 저장한다(세션 선택 정보로 귀속).
      setStatus: (status) => statusWirelessEvent(EVENT_TYPE[mode], status),
      // 디바운스는 routeSensor가 tick 기준으로 직접 처리. 뷰 호환용 no-op.
      setSensorCooldown: () => {},
      // 매뉴얼 모드는 무선에서 미사용(컨트롤러 카드 숨김). 인터페이스 호환용 no-op.
      enableManualMode: () => {},
      disableManualMode: () => {},
      manualSensor: () => {},
    };
  }

  return {
    role, bridgeIsSelf, serialConnected,
    timing, light, mapping, telemetry, bridge, sessions,
    lightColorFor, controllerFor,
    sourceFor,
    claimLease, releaseLease,
    debounceMs, setDebounceMs,
    openSerial, closeSerial,
    serverNow,
    EVENT_TYPE, WIRELESS_EVENTS,
  };
});
