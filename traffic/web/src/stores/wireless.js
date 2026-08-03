import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { msToClockStr } from "./serial";
import {
  ingestWireless,
  reportLight,
  reportBridgeOffline,
  putPhysicalEvent as apiPutPhysicalEvent,
  putWirelessDebounce,
  armWirelessEvent,
  claimWirelessLease,
  releaseWirelessLease,
  fetchServerTime,
  selectWirelessEvent,
  dnfWirelessEvent,
  commandWirelessPhysical,
} from "../composables/useApi";
import {
  wirelessLight,
  wirelessMapping,
  wirelessTelemetry,
  wirelessBridge,
  wirelessSessions,
  onWirelessEvent,
  onWirelessCommand,
} from "../composables/useSSE";
import { WIRELESS_EVENTS, EVENT_TYPE, roleToSensor } from "../composables/useEventTiming";
import { acceptSensorTick } from "../composables/sensorDebounce";
import { ruleFor, shouldLatchStart, shouldIgnore, lapTime } from "@lib/event-timing.mjs";

const TICKS_PER_MS = 16000;
const DEFAULT_DEBOUNCE_MS = 300;
const TYPE_TO_KEY = Object.fromEntries(Object.entries(EVENT_TYPE).map(([k, v]) => [v, k]));
const tickToMs = (t) => Math.round(Number(t || 0) / TICKS_PER_MS);

function makeSlot() {
  return {
    green: { active: false, tick: null, timestamp: null },
    start: { tick: null, timestamp: null, serverMs: null },
    records: [],
    clockDisplay: "00:00.000",
    clockRAF: null,
    lastSensorTrigger: {},
    light: "grey", // 가상 신호등의 로컬 색(물리 지정 경기는 SSE 색을 따름)
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
  const sessions = wirelessSessions; // event_type -> 세션(arm/light/lease) — 서버 권위

  // 센서 디바운스 창(ms). 서버(wireless_light)에 저장돼 wireless:light로 공유. 기본 300ms.
  const debounceMs = computed(() => {
    const v = light.value?.debounce_ms;
    return Number.isFinite(v) ? v : DEFAULT_DEBOUNCE_MS;
  });
  async function setDebounceMs(ms) {
    try { await putWirelessDebounce(ms); }
    catch (e) { notyf.error(e.message); }
  }

  // 물리(실제) 신호등을 사용하도록 지정된 경기(무선 설정). null = 없음(전부 가상).
  const physicalKey = computed(() => {
    const t = light.value?.owner_event;
    return t ? TYPE_TO_KEY[t] || null : null;
  });
  function isPhysical(mode) { return physicalKey.value === mode; }

  function lightColorFor(mode) {
    if (physicalKey.value === mode) {
      const c = light.value?.light_color;
      return c === "green" ? "green" : c === "red" ? "red" : "grey";
    }
    return timing[mode].light;
  }

  // controller 식별자는 email#sessionId(같은 계정의 다른 탭 구분용). 표시는 email만.
  const controllerLabel = (c) => (c ? String(c).split("#")[0] : c);
  // 경기별 세션의 controller(lease 보유자). 표시용(세션 접미 #sid 제거).
  function controllerFor(mode) {
    return controllerLabel(sessions.value?.[EVENT_TYPE[mode]]?.controller) || null;
  }

  // 마스터 시계 추적(브리지가 H 하트비트로). 가상 신호등 green의 master-time 기준값 산출.
  let lastMasterMs = null;
  let lastWall = 0;
  function masterNowMs() {
    return lastMasterMs != null ? Math.round(lastMasterMs + (Date.now() - lastWall)) : Date.now();
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

  // 경기별 세션(SSE, 서버 권위)을 그 경기 슬롯에 반영 — 가상·물리 공통. green=arm.
  // 가상 경기도 서버 세션으로 공유되므로 브리지가 아닌 모든 클라가 동일하게 본다.
  function applySession(s) {
    if (!s) return;
    const mode = TYPE_TO_KEY[s.event_type];
    if (!mode || !timing[mode]) return;
    const slot = timing[mode];
    const previousRunId = appliedRunIds.get(mode);
    const runId = s.run_id ?? null;
    const resetCompleted = previousRunId != null && runId == null;
    appliedRunIds.set(mode, runId);
    slot.light = s.light_color === "off" ? "grey" : s.light_color || "grey";
    if (s.armed) {
      const gt = tickToMs(s.green_tick);
      if (!slot.green.active || slot.green.tick !== gt) activateGreen(mode, gt);
    } else {
      deactivateGreen(mode);
      if (resetCompleted) clearTiming(mode);
    }
  }
  function applyAllSessions() {
    for (const s of Object.values(sessions.value || {})) applySession(s);
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
    const tick = tickToMs(ev.master_tick);
    const node = String(ev.node_id);
    const nowMs = Date.now();
    // server_time은 UTC(strftime 'now', tz 마커 없음) → Z 부착해 UTC로 파싱. 전 클라 동일 기준.
    const st = ev.server_time;
    const serverMs = st ? Date.parse(st.endsWith("Z") ? st : st + "Z") : null;
    for (const row of mapping.value) {
      if (row.node_id !== node || row.enabled === 0) continue;
      const mode = TYPE_TO_KEY[row.event_type];
      if (!mode) continue;
      routeSensor(mode, roleToSensor(mode, row.role), tick, nowMs, Number.isFinite(serverMs) ? serverMs : null);
    }
  }
  onWirelessEvent(handleWirelessEvent);

  // 물리 신호등 다운링크: 브리지만 처리. 실행 직전 isPhysical 재검사(TOCTOU 방어) 후 시리얼 전달.
  onWirelessCommand((cmd) => {
    if (!bridgeIsSelf.value || !cmd) return;
    const mode = TYPE_TO_KEY[cmd.event_type];
    if (!mode || !isPhysical(mode)) return; // 물리 지정 경기가 아니면 무시
    if (cmd.action === "green") transmitLine("G");
    else if (cmd.action === "red") transmitLine("R");
    else if (cmd.action === "off") transmitLine("O");
    else if (cmd.action === "reset") transmitLine("O");
  });

  /* ── 브리지(시리얼) ───────────────────────────────────────────────── */
  let serialPort = null;
  let serialReader = null;
  let intentionalClose = false; // closeSerial()로 끊는 중인지 — read 루프 종료가 분리인지 구분
  const eventBuf = [];
  const telemetryBuf = new Map();
  const MAX_EVENT_BUF = 2000; // 재시도 누적 폭주 방지(타이밍 이벤트가 수천 개면 이미 비정상)
  let flushScheduled = false;
  let flushInFlight = false;
  let hbTimer = null;

  function stateMap(s) { return s === "OK" ? "online" : s === "STALE" ? "degraded" : "lost"; }

  async function flushIngest() {
    if (flushInFlight) return; // 직렬화: 동시 flush로 같은 events 중복 전송/순서 꼬임 방지
    if (!eventBuf.length && !telemetryBuf.size) return;
    flushInFlight = true;
    const events = eventBuf.splice(0, eventBuf.length);
    const tel = [...telemetryBuf.values()];
    telemetryBuf.clear();
    try {
      await ingestWireless({ events, telemetry: tel });
    } catch (e) {
      // 전송 실패(네트워크 끊김·서버 재배포·503 등) 시 이벤트를 유실하면 안 되므로 버퍼
      // 앞으로 되돌려 다음 flush(≤2s heartbeat)에서 재시도. 텔레메트리는 최신값만 의미
      // 있어 재시도하지 않는다.
      if (events.length) {
        eventBuf.unshift(...events);
        if (eventBuf.length > MAX_EVENT_BUF) eventBuf.splice(0, eventBuf.length - MAX_EVENT_BUF);
      }
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
      case "E": // E node ev_seq tmaster flags rssi snr
        eventBuf.push({ node_id: t[1], ev_seq: Number(t[2]), master_tick: t[3], rssi: Number(t[5]), snr: Number(t[6]), link_state: "online" });
        scheduleEventFlush();
        break;
      case "H": // H now_tick uptime_ms beacon_seq nseen — 마스터 시계 추적
        lastMasterMs = Number(t[1]) / TICKS_PER_MS;
        lastWall = Date.now();
        break;
      case "D": // D node state offset skew rx_miss gap last_seen rssi snr lat temp_c10 batt_mv
        telemetryBuf.set(t[1], {
          node_id: t[1], rssi: Number(t[8]), snr: Number(t[9]),
          offset_us: Math.round(Number(t[3]) / 16), skew_ppm: Number(t[4]),
          rx_miss: Number(t[5]), beacon_gap: Number(t[6]),
          // t[7] = 마스터가 이 노드를 마지막으로 들은 뒤 경과(ms). 서버가 절대 "수신" 시각으로 환산.
          last_seen_ms: Number(t[7]),
          latency_ms: Number(t[10]),
          // t[11] = 다이 온도(deci-°C), t[12] = 배터리/충전레일(mV). 마스터(node 0)는 자기 값.
          temp_c10: Number(t[11]), batt_mv: Number(t[12]),
          link_state: stateMap(t[2]),
        });
        break;
      case "L": // L state tick → 물리 신호등 상태를 서버에 보고
        reportLight({ color: (t[1] || "off").toLowerCase(), green_tick: t[2] || "0" }).catch(() => {});
        break;
      case "I": // I FSK-WL <fw> <devid16hex> <freq> <sf> <bw> <ticks> — 마스터 자기 ID (표시 안 함)
        break;
      default: break; // A/X 무시
    }
  }

  async function transmitLine(s) {
    if (!serialPort?.writable) return false;
    const writer = serialPort.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(s + "\n"));
      return true;
    }
    catch (e) { notyf.error(`전송 실패: ${e}`); return false; }
    finally { writer.releaseLock(); }
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
      transmitLine("?ID");
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
  // 비차단 — 가상 전용/마스터 재연결 중 시나리오를 막지 않으려 경고만 띄운다.
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
  // 물리 신호등 원격 제어(비-브리지 컨트롤러 → 서버 → 브리지 시리얼 다운링크).
  async function commandPhysical(mode, action) {
    try {
      await commandWirelessPhysical(EVENT_TYPE[mode], action);
      return true;
    } catch (e) {
      notyf.error(e.message);
      return false;
    }
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

  // green/red/off(=arm/disarm): 가상 → 서버 arm(전 클라 공유). 물리 → 브리지면 시리얼, 아니면 다운링크.
  async function armAction(mode, action, greenTickRaw) {
    // 낙관적(4d): 신호등 색만 즉시 반영. arm·기록·클럭은 applySession이 권위 reconcile. 실패 시 롤백.
    const slot = timing[mode];
    const prevLight = slot.light;
    slot.light = action === "green" ? "green" : action === "red" ? "red" : "grey";
    try {
      await armWirelessEvent({ event_type: EVENT_TYPE[mode], action, green_tick: greenTickRaw });
      return true;
    } catch (e) {
      slot.light = prevLight;
      notyf.error(e.message);
      return false;
    }
  }
  async function physicalControl(mode, action, serialCmd) {
    // 초기화는 브리지 자신이 제어하더라도 서버를 경유해 pending 상태를 남긴다. 이후
    // 마스터의 실제 OFF 보고에서 런 식별자가 폐기되어 모든 클라이언트가 함께 초기화된다.
    if (action === "reset") return commandPhysical(mode, action);
    if (bridgeIsSelf.value) {
      // 브리지: 직접 시리얼. 분리된 포트면 transmitLine이 조용히 무시되던 것을 막고
      // 경고 + 상태 정리(끊김을 read 루프/disconnect가 아직 못 잡은 경우도 여기서 드러난다).
      if (!serialConnected.value || !serialPort?.writable) {
        notyf.error("마스터에 연결되어 있지 않습니다.");
        closeSerial();
        return false;
      }
      return transmitLine(serialCmd);
    }
    return commandPhysical(mode, action); // 비-브리지: 서버→브리지 다운링크(브리지 없으면 서버가 409 경고)
  }
  async function greenFor(mode, team = null, eventName = null) {
    if (!requireControl(mode)) return false;
    warnIfMasterOffline();
    const missing = missingRoles(mode);
    if (missing.length) {
      notyf.open({ type: "warning", message: `센서 미할당: ${missing.map((r) => ROLE_LABEL[r] || r).join(", ")}` });
    }
    if (isPhysical(mode)) return physicalControl(mode, "green", "G");
    // 가상: 클릭 즉시 arm을 낙관 반영(green.active=true → 녹색등 버튼 즉시 잠금, 전처럼).
    // applySession이 같은 green_tick으로 reconcile(재활성 안 함). POST 실패 시 롤백.
    // team·event_name을 arm 본문에 실어 bind-at-arm: /select POST와의 도착 순서 레이스와
    // 무관하게 서버가 arm 시점 귀속을 고정한다(서버 엔진이 run.bound로 사용).
    const gtRaw = String(Math.round(masterNowMs() * TICKS_PER_MS));
    const slot = timing[mode];
    slot.light = "green";
    activateGreen(mode, tickToMs(gtRaw));
    try {
      await armWirelessEvent({ event_type: EVENT_TYPE[mode], action: "green", green_tick: gtRaw, team: team || null, event_name: eventName || null });
      return true;
    } catch (e) {
      deactivateGreen(mode);
      slot.light = "grey";
      notyf.error(e.message);
      return false;
    }
  }
  function redFor(mode) {
    if (!requireControl(mode)) return false;
    if (isPhysical(mode)) return physicalControl(mode, "red", "R");
    return armAction(mode, "red");
  }
  function offFor(mode) {
    if (!requireControl(mode)) return false;
    if (isPhysical(mode)) return physicalControl(mode, "off", "O");
    return armAction(mode, "off");
  }
  async function resetFor(mode) {
    if (!holdsLease(mode)) return false;
    return isPhysical(mode)
      ? await physicalControl(mode, "reset", "O")
      : await armAction(mode, "reset");
  }

  // 무선 설정: 물리 신호등 사용 경기 지정
  async function setPhysicalEvent(mode) {
    try { await apiPutPhysicalEvent(mode ? EVENT_TYPE[mode] : null); }
    catch (e) { notyf.error(e.message); }
  }

  /* ── 유선 이벤트 뷰 재사용 facade (경기별) ───────────────────────── */
  function sourceFor(mode) {
    const slot = timing[mode];
    return {
      get connected() { return bridgeIsSelf.value; },
      get manualMode() { return false; },
      get isBridge() { return bridgeIsSelf.value; },
      get isPhysical() { return isPhysical(mode); },
      // 제어권: lease 보유자만 제어. 관찰자(미보유)는 read-only.
      get isController() { return holdsLease(mode); },
      get controller() { return controllerLabel(sessions.value?.[EVENT_TYPE[mode]]?.controller) || null; },
      // 경기 세션(서버 권위 선택·arm). 관찰자 뷰가 컨트롤러의 팀·이벤트명을 미러하는 데 사용.
      get session() { return sessions.value?.[EVENT_TYPE[mode]] || null; },
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
      // DNF는 서버가 저장(세션 선택 정보로 귀속).
      dnf: () => dnfWirelessEvent(EVENT_TYPE[mode]),
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
    physicalKey, isPhysical, lightColorFor, controllerFor,
    sourceFor, setPhysicalEvent,
    claimLease, releaseLease,
    debounceMs, setDebounceMs,
    openSerial, closeSerial,
    serverNow,
    EVENT_TYPE, WIRELESS_EVENTS,
  };
});
