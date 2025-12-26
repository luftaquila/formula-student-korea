<script setup>
import { ref, computed, onMounted } from 'vue'
import { useEntryStore } from '../stores/entry'
import { useSerialStore, msToClockStr } from '../stores/serial'
import { useNotification } from '../composables/useNotification'
import { addRecord } from '../composables/useApi'

import ControllerConnect from '../components/ControllerConnect.vue'
import TrafficControls from '../components/TrafficControls.vue'
import TrafficLight from '../components/TrafficLight.vue'
import Clock from '../components/Clock.vue'
import TeamSelect from '../components/TeamSelect.vue'

const { notyf } = useNotification()
const entryStore = useEntryStore()
const serial = useSerialStore()

const eventName = ref('')
const selectedTeam = ref(null)
const lapTimes = ref([])
const lastTick = ref(null)

async function onSensor({ sensor, tick, startTick }) {
  if (sensor !== 1) return

  const prevTick = lastTick.value ?? startTick
  if (prevTick === null) {
    lastTick.value = tick
    return
  }

  const lapTime = tick - prevTick
  lastTick.value = tick

  const entry = selectedEntry.value
  if (!entry) return

  const lapNumber = lapTimes.value.length + 1

  const recordData = {
    time: new Date(),
    type: 'skidpad',
    lane: '-',
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result: lapTime,
    detail: `Lap ${lapNumber}`
  }

  try {
    await addRecord(eventName.value.trim(), recordData)
    lapTimes.value.push({ lap: lapNumber, time: lapTime, display: msToClockStr(lapTime) })
    serial.setSensorCooldown(sensor)
    notyf.success(`Lap ${lapNumber} 저장: ${msToClockStr(lapTime)}`)
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`)
  }
}

onMounted(() => {
  serial.setMode('skidpad', onSensor)
  if (!entryStore.isLoaded) entryStore.loadEntries()
})

const currentYear = computed(() => new Date().getFullYear())
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim()}`)
const selectedEntry = computed(() => selectedTeam.value ? entryStore.getEntryByNum(selectedTeam.value) : null)
const entryDisplay = computed(() => selectedEntry.value ? `${selectedEntry.value.num} ${selectedEntry.value.univ} ${selectedEntry.value.team}` : '\u200E')
const isLocked = computed(() => serial.green.active)
const totalTime = computed(() => msToClockStr(lapTimes.value.reduce((sum, lap) => sum + lap.time, 0)))

function handleConnect() { serial.connect() }
function handleGreen() {
  if (!eventName.value.trim()) return notyf.error('이벤트 이름을 입력하세요.')
  if (!selectedTeam.value) return notyf.error('참가팀을 선택하세요.')
  lapTimes.value = []
  lastTick.value = null
  serial.sendGreen()
}
function handleRed() { serial.sendRed() }
function handleOff() { serial.sendOff() }
function handleReset() {
  lapTimes.value = []
  lastTick.value = null
  serial.reset()
}
</script>

<template>
  <div class="container">
    <div class="configuration">
      <h1>⏱️ 스키드패드</h1>
      <div class="mode-description">
        1개의 센서를 출발/도착 기준점에 설치합니다.<br>
        센서 통과 시마다 랩 타임을 자동 저장합니다.
      </div>

      <ControllerConnect :connected="serial.connected" @connect="handleConnect" />
      <TrafficControls :connected="serial.connected" :green-active="serial.green.active" :light-color="serial.lightColor" @green="handleGreen" @red="handleRed" @off="handleOff" />

      <article class="match-config">
        <h2><i class="fa fw fa-calendar-check"></i>경기 설정</h2>
        <div>
          <div>이벤트 이름이 같은 경기는 같은 파일에 기록됩니다.</div>
          <div><i class="fa fa-fw fa-file-signature"></i><input v-model="eventName" class="event-name" placeholder="이벤트 이름" :disabled="isLocked"></div>
          <TeamSelect v-model="selectedTeam" label="1" :disabled="isLocked" />
        </div>
        <div>
          <span class="btn orange" :class="{ disabled: !serial.records.length }" @click="handleReset"><i class="fa fw fa-rotate-left"></i>초기화</span>
        </div>
      </article>
    </div>

    <div class="monitor">
      <h1 class="event-title">{{ titleText }}</h1>
      <article class="time"><TrafficLight :color="serial.lightColor" /><Clock :time="serial.clockDisplay" /></article>
      <article><div class="entry-team">{{ entryDisplay }}</div></article>

      <article class="lap-records">
        <h3>💾 랩 타임</h3>
        <div v-if="lapTimes.length === 0" class="no-laps">센서 통과 대기 중...</div>
        <div v-for="lap in lapTimes" :key="lap.lap" class="lap-item">
          <span class="lap-number">Lap {{ lap.lap }}</span>
          <span class="lap-time">{{ lap.display }}</span>
        </div>
        <div v-if="lapTimes.length > 0" class="total-time">
          <span class="total-label">TOTAL</span>
          <span class="total-value">{{ totalTime }}</span>
        </div>
      </article>

      <article v-if="serial.records.length" class="sensor-log">
        <h4>센서 기록</h4>
        <div v-for="(r, i) in serial.records" :key="i" class="sensor-item">+{{ msToClockStr(r.time) }}</div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.container { display: flex; width: 96%; padding: 1rem; }
.configuration, .monitor { padding: 1rem; padding-bottom: 0; }
.configuration { width: 28rem; flex-shrink: 0; }
.monitor { flex-grow: 1; text-align: center; padding-top: 3rem; }
.mode-description { height: 3rem; margin-top: 1.5rem; margin-bottom: 2.5rem; }
article { margin-left: 1rem; margin-bottom: 2.5rem; }
article:last-child { margin-bottom: 0; }
.monitor article { margin-left: 0; margin-top: 3rem; }
article h2 { font-size: 1.3rem; margin-left: 1rem; margin-bottom: 1rem; }
.configuration article > div { margin-left: 3rem; line-height: 1.7rem; }
.configuration article > div > div { margin-bottom: 1rem; }
.event-title { font-size: 3rem; font-weight: bold; }
.time { display: flex; align-items: center; justify-content: center; }
.entry-team { font-size: 2rem; font-weight: 500; font-style: italic; font-family: "MonoplexKR"; word-break: keep-all; }
.lap-records { max-width: 25rem; margin: 2rem auto; padding: 1.5rem; background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); border-radius: 1rem; }
.lap-records h3 { margin-bottom: 1rem; }
.no-laps { color: #666; font-style: italic; padding: 1rem; }
.lap-item { display: flex; justify-content: space-between; padding: 0.5rem 1rem; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
.lap-number { font-weight: 500; }
.lap-time { font-size: 1.3rem; font-family: "Departure Mono"; font-weight: bold; color: #2e7d32; }
.total-time { display: flex; justify-content: space-between; padding: 1rem; margin-top: 0.5rem; background: rgba(0, 0, 0, 0.1); border-radius: 0.5rem; }
.total-label { font-weight: bold; }
.total-value { font-size: 1.5rem; font-family: "Departure Mono"; font-weight: bold; color: #1b5e20; }
.sensor-log { max-width: 15rem; margin: 0 auto; }
.sensor-log h4 { margin-bottom: 0.5rem; color: #666; }
.sensor-item { font-size: 1.2rem; font-family: "Departure Mono"; text-shadow: 1px 1px 2px grey; padding: 0.3rem; }
input.event-name { width: 15rem; height: 1.5rem; line-height: 1.5rem; }
.match-config div i { margin-right: 0.7rem; }
</style>
