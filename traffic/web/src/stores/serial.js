import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useNotification } from '../composables/useNotification'
import { addControllerLog } from '../composables/useApi'

// Utility function for time formatting
export function msToClockStr(ms) {
  const hours = String(Math.floor(ms / (1000 * 60 * 60))).padStart(2, '0')
  const minutes = String(Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0')
  const seconds = String(Math.floor((ms % (1000 * 60)) / 1000)).padStart(2, '0')
  const millis = String(ms % 1000).padStart(3, '0')
  return `${hours}:${minutes}:${seconds}.${millis}`
}

export const useSerialStore = defineStore('serial', () => {
  const { notyf } = useNotification()

  // Connection state (persists across pages)
  const port = ref(null)
  const connected = ref(false)
  const clockInterval = ref(null)
  const clockDisplay = ref('00:00:00.000')

  const start = ref({ tick: null, timestamp: null })
  const green = ref({ active: false, tick: null, timestamp: null })
  const lightColor = ref('grey')

  const records = ref([])

  // Current mode and callback
  const currentMode = ref(null)
  let onSensorCallback = null

  // Sensor cooldown
  const SENSOR_COOLDOWN_MS = 1000
  const lastSensorTrigger = ref({})

  // Getters
  const isConnected = computed(() => connected.value)
  const isGreenActive = computed(() => green.value.active)

  // Set current mode and callback
  function setMode(mode, callback) {
    currentMode.value = mode
    onSensorCallback = callback
  }

  // Connect to controller
  async function connect() {
    if (!('serial' in navigator)) {
      notyf.error('Web Serial API not supported.')
      return false
    }

    // If already connected, just return true
    if (connected.value && port.value) {
      return true
    }

    try {
      port.value = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x1999, usbProductId: 0x0514 }]
      })
      await port.value.open({ baudRate: 115200 })
      transmit('$HELLO')
      readLoop()
      return true
    } catch (e) {
      notyf.error(`컨트롤러 연결에 실패했습니다.<br>${e}`)
      return false
    }
  }

  async function readLoop() {
    let reader
    let received = ''

    try {
      reader = port.value.readable.getReader()

      while (port.value && port.value.readable) {
        const { value, done } = await reader.read()
        if (done) break

        if (value) {
          received += new TextDecoder().decode(value)
          let idx = received.indexOf('!')

          if (idx > -1) {
            parse(received.slice(received.indexOf('$'), idx))
            received = received.slice(idx + 1)
          }
        }
      }
    } catch (e) {
      if (reader) reader.releaseLock()

      if (e.name === 'NetworkError') {
        handleDisconnect()
        notyf.error(e.message)
      } else {
        notyf.error(`컨트롤러 데이터 수신에 실패했습니다.<br>${e}`)
      }
    }
  }

  function handleDisconnect() {
    green.value.active = false
    connected.value = false
    lightColor.value = 'grey'
    port.value = null
    stopClock()
    clockDisplay.value = '00:00:00.000'
  }

  function parse(data) {
    addControllerLog(new Date(), data)

    if (data.startsWith('$E')) {
      notyf.error('컨트롤러 프로토콜 오류<br>컨트롤러 전원을 껐다 켜세요.')
    } else if (data.startsWith('$HI')) {
      connected.value = true
      lightColor.value = 'grey'
      clockDisplay.value = '00:00:00.000'
      notyf.success('컨트롤러 연결 완료')
    } else if (data.startsWith('$OK G')) {
      handleGreenLight(data)
    } else if (data.startsWith('$OK R')) {
      handleRedLight()
    } else if (data.startsWith('$OK X')) {
      handleLightOff()
    } else if (data.startsWith('$S')) {
      handleSensorReport(data)
    }
  }

  function handleGreenLight(data) {
    green.value.active = true
    green.value.tick = Number(data.slice(6))
    green.value.timestamp = new Date()
    lightColor.value = 'green'

    clockDisplay.value = '00:00:00.000'
    records.value = []
    start.value.tick = null
    start.value.timestamp = null
    lastSensorTrigger.value = {}

    // For gymkhana, start clock immediately from green light
    if (currentMode.value === 'gymkhana') {
      start.value.tick = green.value.tick
      start.value.timestamp = green.value.timestamp
      startClock()
    }
  }

  function handleRedLight() {
    green.value.active = false
    lightColor.value = 'red'
    stopClock()
  }

  function handleLightOff() {
    green.value.active = false
    lightColor.value = 'grey'
    stopClock()
  }

  function handleSensorReport(data) {
    const timestamp = new Date()
    const sensor = Number(data.slice(3, 4))
    const tick = Number(data.slice(5))

    if (!green.value.active) return

    // Check cooldown
    const lastTrigger = lastSensorTrigger.value[sensor]
    if (lastTrigger && (timestamp.getTime() - lastTrigger) < SENSOR_COOLDOWN_MS) {
      return
    }

    // Call the callback with sensor data
    if (onSensorCallback) {
      onSensorCallback({
        sensor,
        tick,
        timestamp,
        greenTick: green.value.tick,
        startTick: start.value.tick,
        startTimestamp: start.value.timestamp
      })
    }

    // Handle clock start for modes that need first sensor trigger
    if (currentMode.value === 'accel' && sensor === 1 && !start.value.timestamp) {
      start.value.tick = tick
      start.value.timestamp = timestamp
      startClock()
    } else if (currentMode.value === 'skidpad' && sensor === 1 && !start.value.timestamp) {
      start.value.tick = tick
      start.value.timestamp = timestamp
      startClock()
    }

    // Add to records for display
    const time = start.value.tick ? tick - start.value.tick : tick - green.value.tick
    records.value.push({ sensor, tick, time, timestamp })
  }

  function startClock() {
    stopClock()
    clockInterval.value = setInterval(() => {
      if (start.value.timestamp) {
        clockDisplay.value = msToClockStr(Date.now() - start.value.timestamp.getTime())
      }
    }, 7)
  }

  function stopClock() {
    if (clockInterval.value) {
      clearInterval(clockInterval.value)
      clockInterval.value = null
    }
  }

  function setSensorCooldown(sensor) {
    lastSensorTrigger.value[sensor] = Date.now()
  }

  function clearRecords() {
    records.value = []
  }

  async function transmit(data) {
    if (!port.value) return false

    let writer
    try {
      writer = port.value.writable.getWriter()
      await writer.write(new TextEncoder().encode(data))
      return true
    } catch (e) {
      notyf.error(`Failed to transmit: ${e}`)
      return false
    } finally {
      if (writer) writer.releaseLock()
    }
  }

  function sendGreen() {
    transmit('$G')
  }

  function sendRed() {
    transmit('$R')
  }

  function sendOff() {
    transmit('$X')
  }

  function reset() {
    stopClock()
    clockDisplay.value = '00:00:00.000'
    records.value = []
    start.value = { tick: null, timestamp: null }
    lastSensorTrigger.value = {}
    transmit('$X')
  }

  return {
    // State
    port,
    connected,
    clockDisplay,
    start,
    green,
    lightColor,
    records,
    currentMode,

    // Getters
    isConnected,
    isGreenActive,

    // Actions
    setMode,
    connect,
    transmit,
    sendGreen,
    sendRed,
    sendOff,
    reset,
    clearRecords,
    setSensorCooldown
  }
})
