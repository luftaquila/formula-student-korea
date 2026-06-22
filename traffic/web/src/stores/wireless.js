import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { msToClockStr } from "./serial";
import {
  ingestWireless,
  reportLight,
  reportBridgeOffline,
  putPhysicalEvent as apiPutPhysicalEvent,
} from "../composables/useApi";
import {
  wirelessLight,
  wirelessMapping,
  wirelessTelemetry,
  wirelessBridge,
  onWirelessEvent,
} from "../composables/useSSE";
import { WIRELESS_EVENTS, EVENT_TYPE, roleToSensor } from "../composables/useEventTiming";
import { acceptSensorTick } from "../composables/sensorDebounce";

const TICKS_PER_MS = 16000;
const SENSOR_COOLDOWN_MS = 1000;
const TYPE_TO_KEY = Object.fromEntries(Object.entries(EVENT_TYPE).map(([k, v]) => [v, k]));
const tickToMs = (t) => Math.round(Number(t || 0) / TICKS_PER_MS);

function makeSlot() {
  return {
    green: { active: false, tick: null, timestamp: null },
    start: { tick: null, timestamp: null },
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
  const callbacks = {}; // mode -> 뷰의 onSensor (유선 뷰와 동일 로직)

  // SSE 실시간 상태
  const light = wirelessLight;
  const mapping = wirelessMapping;
  const telemetry = wirelessTelemetry;
  const bridge = wirelessBridge;

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

  // 마스터 시계 추적(브리지가 H 하트비트로). 가상 신호등 green의 master-time 기준값 산출.
  let lastMasterMs = null;
  let lastWall = 0;
  function masterNowMs() {
    return lastMasterMs != null ? Math.round(lastMasterMs + (Date.now() - lastWall)) : Date.now();
  }

  /* ── 클럭 ──────────────────────────────────────────────────────── */
  function startClock(slot) {
    stopClock(slot);
    const tick = () => {
      if (slot.start.timestamp) slot.clockDisplay = msToClockStr(Date.now() - slot.start.timestamp.getTime());
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
    slot.start = { tick: null, timestamp: null };
    slot.lastSensorTrigger = {};
    if (mode === "gymkhana" || mode === "autocross") {
      slot.start = { tick: greenTickMs, timestamp: slot.green.timestamp };
      startClock(slot);
    }
  }
  function deactivateGreen(mode) {
    const slot = timing[mode];
    slot.green.active = false;
    stopClock(slot);
  }

  // 물리 지정 경기의 신호등 상태(SSE)를 그 경기 슬롯에 반영.
  function applyLight(l) {
    const pKey = l?.owner_event ? TYPE_TO_KEY[l.owner_event] || null : null;
    if (!pKey) return;
    const slot = timing[pKey];
    const color = l?.light_color || "off";
    if (color === "green") {
      const gt = tickToMs(l.green_tick);
      if (!slot.green.active || slot.green.tick !== gt) activateGreen(pKey, gt);
    } else {
      deactivateGreen(pKey);
    }
  }
  watch(light, (l) => applyLight(l), { deep: true });
  applyLight(light.value);

  /* ── 센서 라우팅(serial.handleSensorReport와 동일 순서) ───────────── */
  // 디바운스(tick 기준): 한 통과의 다중 엣지(바운스, ~30~150ms)를 접는다. 벽시계가 아니라
  // 이벤트 캡처 시각(tick)으로 비교하므로 버퍼링·지연·재전송·백필로 도착이 흩어져도 안전.
  function routeSensor(mode, sensor, tick, nowMs) {
    const slot = timing[mode];
    if (!slot.green.active) return;
    if (!acceptSensorTick(slot.lastSensorTrigger, sensor, tick, SENSOR_COOLDOWN_MS)) return;

    const payload = {
      sensor, tick,
      timestamp: new Date(nowMs),
      greenTick: slot.green.tick,
      startTick: slot.start.tick,
      startTimestamp: slot.start.timestamp,
    };
    try { callbacks[mode]?.(payload); } catch (e) { notyf.error(`기록 처리 실패: ${e.message}`); }

    if ((mode === "accel" || mode === "skidpad") && sensor === 1 && !slot.start.timestamp) {
      slot.start.tick = tick;
      slot.start.timestamp = new Date(nowMs);
      startClock(slot);
    }
    if (mode === "skidpad" && sensor !== 1) return;
    const time = slot.start.tick ? tick - slot.start.tick : tick - slot.green.tick;
    slot.records.push({ sensor, tick, time, timestamp: new Date(nowMs) });
  }

  function handleWirelessEvent(ev) {
    const tick = tickToMs(ev.master_tick);
    const node = String(ev.node_id);
    const nowMs = Date.now();
    for (const row of mapping.value) {
      if (row.node_id !== node || row.enabled === 0) continue;
      const mode = TYPE_TO_KEY[row.event_type];
      if (!mode) continue;
      routeSensor(mode, roleToSensor(mode, row.role), tick, nowMs);
    }
  }
  onWirelessEvent(handleWirelessEvent);

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
      default: break; // I/A/X 무시
    }
  }

  async function transmitLine(s) {
    if (!serialPort?.writable) return;
    const writer = serialPort.writable.getWriter();
    try { await writer.write(new TextEncoder().encode(s + "\n")); }
    catch (e) { notyf.error(`전송 실패: ${e}`); }
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
    // 서버에 즉시 오프라인 보고 → "마스터 연결"이 15s 워치독을 기다리지 않고 바로 풀린다.
    if (wasBridge) reportBridgeOffline().catch(() => {});
  }

  /* ── 신호등 제어 (브리지 콘솔 전용) ──────────────────────────────── */
  function requireBridge() {
    if (!bridgeIsSelf.value) { notyf.error("신호등은 마스터에 연결된 PC에서만 제어할 수 있습니다."); return false; }
    return true;
  }

  // 경기별 필요 역할(센서). 미할당 역할이 있으면 그 구간은 기록되지 않는다.
  const REQUIRED_ROLES = { accel: ["start", "finish"], gymkhana: ["lane1", "lane2"], skidpad: ["start"], autocross: ["start"] };
  const ROLE_LABEL = { start: "출발", finish: "도착", lane1: "레인 1", lane2: "레인 2" };
  // 해당 경기에서 enabled 매핑이 없는(미할당) 필요 역할 목록.
  function missingRoles(mode) {
    const have = new Set(
      mapping.value.filter((m) => m.enabled !== 0 && m.event_type === EVENT_TYPE[mode]).map((m) => m.role),
    );
    return (REQUIRED_ROLES[mode] || []).filter((r) => !have.has(r));
  }

  // green/red/off: 물리 지정 경기 → 마스터 SSR 제어, 그 외 → 가상(로컬) 신호등.
  function greenFor(mode) {
    if (!requireBridge()) return;
    const missing = missingRoles(mode);
    if (missing.length) {
      notyf.open({ type: "warning", message: `센서 미할당: ${missing.map((r) => ROLE_LABEL[r] || r).join(", ")}` });
    }
    if (isPhysical(mode)) {
      transmitLine("G"); // SSR on; L GREEN → reportLight → SSE → applyLight가 슬롯 green 설정
    } else {
      timing[mode].light = "green";
      activateGreen(mode, masterNowMs());
    }
  }
  function redFor(mode) {
    if (!requireBridge()) return;
    if (isPhysical(mode)) transmitLine("R");
    else { timing[mode].light = "red"; deactivateGreen(mode); }
  }
  function offFor(mode) {
    if (!requireBridge()) return;
    if (isPhysical(mode)) transmitLine("O");
    else { timing[mode].light = "grey"; deactivateGreen(mode); }
  }
  function resetFor(mode) {
    const slot = timing[mode];
    stopClock(slot);
    slot.clockDisplay = "00:00.000"; slot.records = []; slot.start = { tick: null, timestamp: null };
    slot.lastSensorTrigger = {}; slot.green.active = false; slot.light = "grey";
    if (isPhysical(mode) && bridgeIsSelf.value) transmitLine("O");
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
      get green() { return slot.green; },
      get records() { return slot.records; },
      get clockDisplay() { return slot.clockDisplay; },
      get lightColor() { return lightColorFor(mode); },
      setMode: (_m, cb) => { callbacks[mode] = cb; },
      connect: () => openSerial(),
      sendGreen: () => greenFor(mode),
      sendRed: () => redFor(mode),
      sendOff: () => offFor(mode),
      reset: () => resetFor(mode),
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
    timing, light, mapping, telemetry, bridge,
    physicalKey, isPhysical, lightColorFor,
    sourceFor, setPhysicalEvent,
    openSerial, closeSerial,
    EVENT_TYPE, WIRELESS_EVENTS,
  };
});
