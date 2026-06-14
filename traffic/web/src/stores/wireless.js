import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { useEntryStore } from "./entry";
import { msToClockStr } from "./serial";
import {
  addRecord,
  ingestWireless,
  reportLight,
  claimLight as apiClaimLight,
  releaseLight as apiReleaseLight,
} from "../composables/useApi";
import {
  wirelessLight,
  wirelessMapping,
  wirelessTelemetry,
  wirelessBridge,
  onWirelessEvent,
} from "../composables/useSSE";
import {
  WIRELESS_EVENTS,
  EVENT_TYPE,
  EVENT_TITLE,
  roleToSensor,
  freshRun,
  freshConfig,
  onSensorRule,
  dnfRule,
} from "../composables/useEventTiming";

const TICKS_PER_MS = 16000;
const SENSOR_COOLDOWN_MS = 1000;
const TYPE_TO_KEY = Object.fromEntries(Object.entries(EVENT_TYPE).map(([k, v]) => [v, k]));

function tickToMs(t) {
  // 마스터 64-bit tick(문자열/숫자) -> 정수 ms (레거시와 동일한 ms 도메인)
  return Math.round(Number(t || 0) / TICKS_PER_MS);
}

function makeSlot(eventKey) {
  return {
    green: { active: false, tick: null, timestamp: null },
    start: { tick: null, timestamp: null },
    records: [],
    clockDisplay: "00:00:00.000",
    clockRAF: null,
    lastSensorTrigger: {},
    run: freshRun(eventKey),
    config: freshConfig(),
  };
}

export const useWirelessStore = defineStore("wireless", () => {
  const { notyf } = useNotification();
  const entryStore = useEntryStore();

  const role = ref("client"); // "client" | "bridge"
  const bridgeIsSelf = ref(false);
  const serialConnected = ref(false);

  // 이벤트별 타이밍 상태(동시 진행 + 네비게이션 유지를 위해 store에 둔다)
  const timing = reactive({});
  for (const key of WIRELESS_EVENTS) timing[key] = makeSlot(key);

  // SSE 실시간 상태(노출용)
  const light = wirelessLight;
  const mapping = wirelessMapping;
  const telemetry = wirelessTelemetry;
  const bridge = wirelessBridge;

  const ownerKey = computed(() => {
    const t = light.value?.owner_event;
    return t ? TYPE_TO_KEY[t] || null : null;
  });

  function isClaimedByOther(eventKey) {
    return !!ownerKey.value && ownerKey.value !== eventKey;
  }

  function lightColorFor(eventKey) {
    if (ownerKey.value !== eventKey) return "grey";
    const c = light.value?.light_color;
    if (c === "green") return "green";
    if (c === "red") return "red";
    return "grey";
  }

  /* ── 클럭 ──────────────────────────────────────────────────────── */
  function startClock(slot) {
    stopClock(slot);
    const tick = () => {
      if (slot.start.timestamp) {
        slot.clockDisplay = msToClockStr(Date.now() - slot.start.timestamp.getTime());
      }
      slot.clockRAF = requestAnimationFrame(tick);
    };
    slot.clockRAF = requestAnimationFrame(tick);
  }
  function stopClock(slot) {
    if (slot.clockRAF) {
      cancelAnimationFrame(slot.clockRAF);
      slot.clockRAF = null;
    }
  }

  /* ── 신호등 상태 적용(SSE wireless:light) ─────────────────────────── */
  function handleGreen(eventKey, greenTickMs) {
    const slot = timing[eventKey];
    slot.green = { active: true, tick: greenTickMs, timestamp: new Date() };
    slot.clockDisplay = "00:00:00.000";
    slot.records = [];
    slot.start = { tick: null, timestamp: null };
    slot.lastSensorTrigger = {};
    slot.run = freshRun(eventKey);
    if (eventKey === "gymkhana" || eventKey === "autocross") {
      slot.start = { tick: greenTickMs, timestamp: slot.green.timestamp };
      startClock(slot);
    }
  }

  function applyLight(l) {
    const oKey = l?.owner_event ? TYPE_TO_KEY[l.owner_event] || null : null;
    const color = l?.light_color || "off";
    // 점유 이벤트가 아닌 슬롯은 비활성화
    for (const key of WIRELESS_EVENTS) {
      if (key !== oKey && timing[key].green.active) {
        timing[key].green.active = false;
        stopClock(timing[key]);
      }
    }
    if (!oKey) return;
    const slot = timing[oKey];
    if (color === "green") {
      const gtMs = tickToMs(l.green_tick);
      if (!slot.green.active || slot.green.tick !== gtMs) handleGreen(oKey, gtMs);
    } else {
      slot.green.active = false;
      stopClock(slot);
    }
  }

  watch(light, (l) => applyLight(l), { deep: true });
  applyLight(light.value);

  /* ── 이벤트 라우팅(SSE wireless:event) ───────────────────────────── */
  function ctxFor(slot) {
    return {
      setCooldown: (sensor) => { slot.lastSensorTrigger[sensor] = Date.now(); },
      getEntry: (num) => entryStore.getEntryByNum(num),
      addRecord: (name, data) => addRecord(name, data),
      notify: (m) => notyf.success(m),
      notifyError: (m) => notyf.error(m),
    };
  }

  function routeSensor(eventKey, sensor, tick, nowMs) {
    const slot = timing[eventKey];
    if (!slot.green.active) return;
    const last = slot.lastSensorTrigger[sensor];
    if (last && nowMs - last < SENSOR_COOLDOWN_MS) return;

    const payload = {
      sensor, tick,
      timestamp: new Date(nowMs),
      greenTick: slot.green.tick,
      startTick: slot.start.tick,
      startTimestamp: slot.start.timestamp,
    };
    // 이벤트별 저장 로직(레거시 뷰 onSensor와 동일). 동기 부분이 먼저 실행되고
    // addRecord는 await — 호출만 하고 기다리지 않아 레거시 순서를 보존한다.
    onSensorRule(eventKey, slot, payload, ctxFor(slot)).catch((e) =>
      notyf.error(`기록 저장 실패: ${e.message}`),
    );
    // 클럭 시작(accel/skidpad는 첫 센서에서)
    if ((eventKey === "accel" || eventKey === "skidpad") && sensor === 1 && !slot.start.timestamp) {
      slot.start.tick = tick;
      slot.start.timestamp = new Date(nowMs);
      startClock(slot);
    }
    // records push (스키드패드는 센서1만)
    if (eventKey === "skidpad" && sensor !== 1) return;
    const time = slot.start.tick ? tick - slot.start.tick : tick - slot.green.tick;
    slot.records.push({ sensor, tick, time, timestamp: new Date(nowMs) });
  }

  function handleWirelessEvent(ev) {
    const tick = tickToMs(ev.master_tick);
    const node = String(ev.node_id);
    const nowMs = Date.now();
    for (const row of mapping.value) {
      if (row.node_id !== node || row.enabled === 0) continue;
      const eventKey = TYPE_TO_KEY[row.event_type];
      if (!eventKey) continue;
      routeSensor(eventKey, roleToSensor(eventKey, row.role), tick, nowMs);
    }
  }
  onWirelessEvent(handleWirelessEvent);

  /* ── 브리지(시리얼) ───────────────────────────────────────────────── */
  let serialPort = null;
  let serialReader = null;
  const eventBuf = [];
  const telemetryBuf = new Map();
  let flushScheduled = false;
  let hbTimer = null;

  function stateMap(s) {
    return s === "OK" ? "online" : s === "STALE" ? "degraded" : "lost";
  }

  async function flushIngest() {
    const events = eventBuf.splice(0, eventBuf.length);
    const tel = [...telemetryBuf.values()];
    telemetryBuf.clear();
    try {
      await ingestWireless({ events, telemetry: tel });
    } catch (e) {
      // 다음 주기에 재시도되지 않으므로(버퍼 비움) 단순 경고
      notyf.error(`서버 전송 실패: ${e.message}`);
    }
  }

  function scheduleEventFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => { flushScheduled = false; flushIngest(); }, 0);
  }

  // 한 줄(개행 구분) 파싱. 브리지가 수신한 마스터 프로토콜.
  function parseLine(line) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) return;
    switch (t[0]) {
      case "E": // E node ev_seq tmaster flags rssi snr
        eventBuf.push({
          node_id: t[1], ev_seq: Number(t[2]), master_tick: t[3],
          rssi: Number(t[5]), snr: Number(t[6]), link_state: "online",
        });
        scheduleEventFlush();
        break;
      case "D": // D node state offset skew rx_miss gap last_seen rssi snr lat
        telemetryBuf.set(t[1], {
          node_id: t[1],
          rssi: Number(t[8]), snr: Number(t[9]),
          offset_us: Math.round(Number(t[3]) / 16),
          skew_ppm: Number(t[4]),
          latency_ms: Number(t[10]),
          link_state: stateMap(t[2]),
        });
        break;
      case "L": // L state tick — 신호등 ack를 서버에 보고
        reportLight({ color: (t[1] || "off").toLowerCase(), green_tick: t[2] || "0" }).catch(() => {});
        break;
      // I / H / A / X 는 무시(H는 heartbeat 타이머가 ingest로 처리)
      default:
        break;
    }
  }

  async function transmitLine(s) {
    if (!serialPort?.writable) return;
    const writer = serialPort.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(s + "\n"));
    } catch (e) {
      notyf.error(`전송 실패: ${e}`);
    } finally {
      writer.releaseLock();
    }
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
          while ((idx = buffer.indexOf("\n")) > -1) {
            parseLine(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
          }
        }
      }
    } catch (e) {
      notyf.error(`마스터 수신 실패: ${e}`);
    } finally {
      if (serialReader) serialReader.releaseLock();
    }
  }

  async function openSerial() {
    if (!("serial" in navigator)) { notyf.error("이 브라우저는 Web Serial을 지원하지 않습니다."); return false; }
    if (bridge.value.online && !bridgeIsSelf.value) { notyf.error("이미 다른 PC가 브리지로 연결되어 있습니다."); return false; }
    try {
      serialPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x1999, usbProductId: 0x0515 }] });
      await serialPort.open({ baudRate: 115200 });
      role.value = "bridge";
      bridgeIsSelf.value = true;
      serialConnected.value = true;
      transmitLine("?ID");
      hbTimer = setInterval(flushIngest, 2000); // 센서가 없어도 브리지 online 유지
      bridgeReadLoop();
      notyf.success("마스터 연결 완료 (이 PC가 브리지)");
      return true;
    } catch (e) {
      notyf.error(`마스터 연결 실패: ${e}`);
      return false;
    }
  }

  async function closeSerial() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    try { await serialReader?.cancel(); } catch { /* ignore */ }
    try { await serialPort?.close(); } catch { /* ignore */ }
    serialPort = null;
    serialReader = null;
    serialConnected.value = false;
    bridgeIsSelf.value = false;
    role.value = "client";
  }

  /* ── 신호등/점유 제어(브리지 콘솔 전용) ───────────────────────────── */
  function requireBridge() {
    if (!bridgeIsSelf.value) {
      notyf.error("신호등은 마스터에 연결된 브리지 PC에서만 제어할 수 있습니다.");
      return false;
    }
    return true;
  }

  async function claim(eventKey) {
    try { await apiClaimLight(EVENT_TYPE[eventKey]); return true; }
    catch (e) { notyf.error(e.message); return false; }
  }
  async function release(eventKey) {
    try { await apiReleaseLight(EVENT_TYPE[eventKey]); return true; }
    catch (e) { notyf.error(e.message); return false; }
  }

  async function greenFor(eventKey) {
    if (!requireBridge()) return;
    if (isClaimedByOther(eventKey)) { notyf.error("다른 종목이 신호등을 점유 중입니다."); return; }
    if (ownerKey.value !== eventKey) {
      if (!(await claim(eventKey))) return;
    }
    transmitLine("G");
  }
  async function redFor() {
    if (!requireBridge()) return;
    transmitLine("R");
  }
  async function offFor() {
    if (!requireBridge()) return;
    transmitLine("O");
  }

  function resetSlot(eventKey) {
    const slot = timing[eventKey];
    stopClock(slot);
    slot.clockDisplay = "00:00:00.000";
    slot.records = [];
    slot.start = { tick: null, timestamp: null };
    slot.lastSensorTrigger = {};
    slot.run = freshRun(eventKey);
    slot.green.active = false;
  }

  async function resetFor(eventKey) {
    resetSlot(eventKey);
    if (bridgeIsSelf.value && ownerKey.value === eventKey) {
      transmitLine("O");
      await release(eventKey);
    }
  }

  async function dnf(eventKey, lane = 1) {
    const slot = timing[eventKey];
    try {
      await dnfRule(eventKey, slot, ctxFor(slot), lane);
    } catch (e) {
      notyf.error(`DNF 저장 실패: ${e.message}`);
    }
  }

  /* ── 테스트/개발용 시뮬레이션 ────────────────────────────────────── */
  function simulateLine(line) { parseLine(line); }
  let simSeq = 1;
  function simulateSensor(node, tickMs) {
    const tick = (tickMs != null ? tickMs : Date.now() % 1e9) * TICKS_PER_MS;
    parseLine(`E ${node} ${simSeq++} ${tick} 0 -60.0 9.0`);
  }

  return {
    // state
    role, bridgeIsSelf, serialConnected,
    timing, light, mapping, telemetry, bridge,
    ownerKey,
    // accessors
    slot: (key) => timing[key],
    lightColorFor, isClaimedByOther,
    EVENT_TYPE, EVENT_TITLE, WIRELESS_EVENTS,
    // bridge
    openSerial, closeSerial,
    // controls
    greenFor, redFor, offFor, resetFor, dnf, claim, release,
    // dev
    simulateLine, simulateSensor,
  };
});
