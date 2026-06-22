import { defineStore } from "pinia";
import { ref } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { addControllerLog } from "../composables/useApi";
import { acceptSensorTick } from "../composables/sensorDebounce";
import { ruleFor, shouldLatchStart, shouldIgnore, lapTime } from "@shared/event-timing.js";

// Utility function for time formatting (분:초.밀리초, 분은 60 이상 가능)
export function msToClockStr(ms) {
  if (ms < 0) ms = 0;
  ms = Math.floor(ms); // live clock elapsed can be fractional (server-offset/serverMs floats); keep millis integer
  const totalMinutes = Math.floor(ms / (1000 * 60));
  const minutes = String(totalMinutes).padStart(2, "0");
  const seconds = String(Math.floor((ms % (1000 * 60)) / 1000)).padStart(2, "0");
  const millis = String(ms % 1000).padStart(3, "0");
  return `${minutes}:${seconds}.${millis}`;
}

export const useSerialStore = defineStore("serial", () => {
  const { notyf } = useNotification();

  // Connection state (persists across pages)
  const port = ref(null);
  const connected = ref(false);
  const clockInterval = ref(null);
  const clockDisplay = ref("00:00.000");

  const start = ref({ tick: null, timestamp: null });
  const green = ref({ active: false, tick: null, timestamp: null });
  const lightColor = ref("grey");

  const records = ref([]);

  // Current mode and callback
  const currentMode = ref(null);
  let onSensorCallback = null;

  // Sensor debounce window (ms). 유선은 무선 설정과 별도로 기본 300ms 고정.
  const SENSOR_COOLDOWN_MS = 300;
  const lastSensorTrigger = ref({});

  // Manual mode state
  const manualMode = ref(false);
  const manualBaseTick = ref(0);
  const manualBaseTime = ref(0);

  function getManualTick() {
    return manualBaseTick.value + (Date.now() - manualBaseTime.value);
  }

  function enableManualMode() {
    manualMode.value = true;
    connected.value = true;
    manualBaseTick.value = 1000000;
    manualBaseTime.value = Date.now();
  }

  function disableManualMode() {
    manualMode.value = false;
    connected.value = false;
    reset();
  }

  // Set current mode and callback
  function setMode(mode, callback) {
    currentMode.value = mode;
    onSensorCallback = callback;
  }

  // Connect to controller
  async function connect() {
    if (!("serial" in navigator)) {
      notyf.error("Web Serial API not supported.");
      return false;
    }

    // If already connected, just return true
    if (connected.value && port.value) {
      return true;
    }

    try {
      port.value = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x1999, usbProductId: 0x0514 }],
      });
      await port.value.open({ baudRate: 115200 });
      transmit("$HELLO");
      readLoop();
      return true;
    } catch (e) {
      notyf.error(`컨트롤러 연결에 실패했습니다. ${e}`);
      return false;
    }
  }

  async function readLoop() {
    let reader;
    let received = "";

    try {
      reader = port.value.readable.getReader();

      while (port.value && port.value.readable) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          received += new TextDecoder().decode(value);
          let idx;

          while ((idx = received.indexOf("!")) > -1) {
            const start = received.indexOf("$");
            if (start > -1 && start < idx) {
              parse(received.slice(start, idx));
            }
            received = received.slice(idx + 1);
          }
        }
      }
    } catch (e) {
      if (e.name === "NetworkError") {
        handleDisconnect();
        notyf.error(e.message);
      } else {
        notyf.error(`컨트롤러 데이터 수신에 실패했습니다. ${e}`);
      }
    } finally {
      if (reader) reader.releaseLock();
    }
  }

  function handleDisconnect() {
    green.value.active = false;
    connected.value = false;
    lightColor.value = "grey";
    port.value = null;
    stopClock();
    clockDisplay.value = "00:00.000";
    records.value = [];
    start.value = { tick: null, timestamp: null };
    lastSensorTrigger.value = {};
  }

  function parse(data) {
    addControllerLog(new Date(), data);

    if (data.startsWith("$E")) {
      notyf.error("컨트롤러 프로토콜 오류 컨트롤러 전원을 껐다 켜세요.");
    } else if (data.startsWith("$HI")) {
      connected.value = true;
      lightColor.value = "grey";
      clockDisplay.value = "00:00.000";
      notyf.success("컨트롤러 연결 완료");
    } else if (data.startsWith("$OK G")) {
      handleGreenLight(Number(data.slice(6)));
    } else if (data.startsWith("$OK R")) {
      handleRedLight();
    } else if (data.startsWith("$OK X")) {
      handleLightOff();
    } else if (data.startsWith("$S")) {
      handleSensorReport(Number(data.slice(3, 4)), Number(data.slice(5)));
    }
  }

  function handleGreenLight(tick) {
    green.value.active = true;
    green.value.tick = tick;
    green.value.timestamp = new Date();
    lightColor.value = "green";

    clockDisplay.value = "00:00.000";
    records.value = [];
    start.value.tick = null;
    start.value.timestamp = null;
    lastSensorTrigger.value = {};
    // green = arm일 뿐 t0가 아니다. 전 경기 t0는 출발 센서(handleSensorReport에서 래치).
  }

  function handleRedLight() {
    green.value.active = false;
    lightColor.value = "red";
    stopClock();
  }

  function handleLightOff() {
    green.value.active = false;
    lightColor.value = "grey";
    stopClock();
  }

  function handleSensorReport(sensor, tick) {
    const timestamp = new Date();

    if (!green.value.active) return;

    // 디바운스(수신 계층, tick 기준): 한 통과의 다중 엣지(바운스, ~30~150ms)를 접는다.
    // 뷰의 setSensorCooldown에 의존하지 않으므로 첫 통과 등 모든 경로가 보호된다.
    if (!acceptSensorTick(lastSensorTrigger.value, sensor, tick, SENSOR_COOLDOWN_MS)) return;

    // Call the callback with sensor data
    if (onSensorCallback) {
      onSensorCallback({
        sensor,
        tick,
        timestamp,
        greenTick: green.value.tick,
        startTick: start.value.tick,
        startTimestamp: start.value.timestamp,
      });
    }

    // 출발 센서에서 t0 래치(accel/autocross/skidpad 모두 센서 1). green은 arm일 뿐.
    const rule = ruleFor(currentMode.value);
    if (shouldLatchStart(rule, sensor, !!start.value.timestamp)) {
      start.value.tick = tick;
      start.value.timestamp = timestamp;
      startClock();
    }

    // 단일 센서 경기(스키드패드)는 출발 센서 외 무시.
    if (shouldIgnore(rule, sensor)) return;

    const time = lapTime(tick, start.value.tick, green.value.tick);
    records.value.push({ sensor, tick, time, timestamp });
  }

  function startClock() {
    stopClock();
    function tick() {
      if (start.value.timestamp) {
        clockDisplay.value = msToClockStr(Date.now() - start.value.timestamp.getTime());
      }
      clockInterval.value = requestAnimationFrame(tick);
    }
    clockInterval.value = requestAnimationFrame(tick);
  }

  function stopClock() {
    if (clockInterval.value) {
      cancelAnimationFrame(clockInterval.value);
      clockInterval.value = null;
    }
  }

  // 디바운스는 handleSensorReport가 tick 기준으로 직접 처리. 뷰 호환용 no-op.
  function setSensorCooldown() {}

  async function transmit(data) {
    if (!port.value) return false;

    let writer;
    try {
      writer = port.value.writable.getWriter();
      await writer.write(new TextEncoder().encode(data));
      return true;
    } catch (e) {
      notyf.error(`Failed to transmit: ${e}`);
      return false;
    } finally {
      if (writer) writer.releaseLock();
    }
  }

  function sendGreen() {
    if (manualMode.value) {
      manualBaseTime.value = Date.now();
      handleGreenLight(getManualTick());
      return;
    }
    transmit("$G");
  }

  function sendRed() {
    if (manualMode.value) {
      handleRedLight();
      return;
    }
    transmit("$R");
  }

  function sendOff() {
    if (manualMode.value) {
      handleLightOff();
      return;
    }
    transmit("$X");
  }

  function manualSensor(sensorNum) {
    if (!manualMode.value || !green.value.active) return;
    handleSensorReport(sensorNum, getManualTick());
  }

  function reset() {
    stopClock();
    clockDisplay.value = "00:00.000";
    records.value = [];
    start.value = { tick: null, timestamp: null };
    lastSensorTrigger.value = {};
    green.value = { active: false, tick: null, timestamp: null };
    lightColor.value = "grey";
    if (!manualMode.value) transmit("$X");
  }

  return {
    // State
    connected,
    clockDisplay,
    green,
    lightColor,
    records,
    manualMode,

    // Actions
    setMode,
    connect,
    sendGreen,
    sendRed,
    sendOff,
    reset,
    setSensorCooldown,
    enableManualMode,
    disableManualMode,
    manualSensor,
  };
});
