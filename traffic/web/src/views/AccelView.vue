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

// Form state
const eventName = ref('')
const selectedTeam = ref(null)
const startRecord = ref(null)
const savedRecords = ref([])

// Auto-save on sensor trigger
async function onSensor({ sensor, tick, greenTick }) {
  if (sensor === 1) {
    if (!startRecord.value) {
      startRecord.value = { tick }
    }
  } else if (sensor === 2 && startRecord.value) {
    const result = tick - startRecord.value.tick
    const entry = selectedEntry.value

    if (!entry) return

    const recordData = {
      time: new Date(),
      type: 'accel',
      lane: '-',
      entry: {
        num: entry.num,
        univ: entry.univ,
        team: entry.team
      },
      result,
      detail: `${startRecord.value.tick - greenTick} ms delayed start`
    }

    try {
      await addRecord(eventName.value.trim(), recordData)
      savedRecords.value.push({ result, time: msToClockStr(result) })
      serial.setSensorCooldown(sensor)
      notyf.success(`기록 저장: ${msToClockStr(result)}`)
    } catch (e) {
      notyf.error(`기록 저장 실패: ${e.message}`)
    }
  }
}

onMounted(() => {
  serial.setMode('accel', onSensor)
  if (!entryStore.isLoaded) {
    entryStore.loadEntries()
  }
})

const currentYear = computed(() => new Date().getFullYear())
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim()}`)

const selectedEntry = computed(() => {
  if (!selectedTeam.value) return null
  return entryStore.getEntryByNum(selectedTeam.value)
})

const entryDisplay = computed(() => {
  if (!selectedEntry.value) return '\u200E'
  const e = selectedEntry.value
  return `${e.num} ${e.univ} ${e.team}`
})

const isLocked = computed(() => serial.green.active)
const startRecords = computed(() => serial.records.filter(r => r.sensor === 1))
const endRecords = computed(() => serial.records.filter(r => r.sensor === 2))

function handleConnect() {
  serial.connect()
}

function handleGreen() {
  if (!eventName.value.trim()) {
    return notyf.error('이벤트 이름을 입력하세요.')
  }
  if (!selectedTeam.value) {
    return notyf.error('참가팀을 선택하세요.')
  }
  startRecord.value = null
  savedRecords.value = []
  serial.sendGreen()
}

function handleRed() {
  serial.sendRed()
}

function handleOff() {
  serial.sendOff()
}

function handleReset() {
  startRecord.value = null
  savedRecords.value = []
  serial.reset()
}
</script>

<template>
  <div class="container">
    <div class="configuration">
      <h1>🏎️ 가속 측정</h1>

      <div class="mode-description">
        1번 센서를 출발점에, 2번 센서를 도착점에 설치합니다.<br>
        출발점부터 도착점까지의 통과 소요 시간을 자동 저장합니다.
      </div>

      <ControllerConnect :connected="serial.connected" @connect="handleConnect" />

      <TrafficControls
        :connected="serial.connected"
        :green-active="serial.green.active"
        :light-color="serial.lightColor"
        @green="handleGreen"
        @red="handleRed"
        @off="handleOff"
      />

      <article class="match-config">
        <h2><i class="fa fw fa-calendar-check"></i>경기 설정</h2>
        <div>
          <div>이벤트 이름이 같은 경기는 같은 파일에 기록됩니다.</div>
          <div>
            <i class="fa fa-fw fa-file-signature"></i>
            <input v-model="eventName" class="event-name" placeholder="이벤트 이름" :disabled="isLocked">
          </div>
          <TeamSelect v-model="selectedTeam" label="1" :disabled="isLocked" />
        </div>
        <div>
          <span class="btn orange" :class="{ disabled: !serial.records.length }" @click="handleReset">
            <i class="fa fw fa-rotate-left"></i>초기화
          </span>
        </div>
      </article>
    </div>

    <div class="monitor">
      <h1 class="event-title">{{ titleText }}</h1>

      <article class="time">
        <TrafficLight :color="serial.lightColor" />
        <Clock :time="serial.clockDisplay" />
      </article>

      <article>
        <div class="entry-team">{{ entryDisplay }}</div>
      </article>

      <article class="time-records">
        <div class="record-column">
          <h3>출발점</h3>
          <div v-for="(record, idx) in startRecords" :key="idx" class="record-item">
            +{{ msToClockStr(record.time) }}
          </div>
        </div>
        <div class="record-column">
          <h3>도착점</h3>
          <div v-for="(record, idx) in endRecords" :key="idx" class="record-item">
            +{{ msToClockStr(record.time) }}
          </div>
        </div>
      </article>

      <article v-if="savedRecords.length" class="saved-records">
        <h3>💾 저장된 기록</h3>
        <div v-for="(record, idx) in savedRecords" :key="idx" class="saved-item">
          {{ record.time }}
        </div>
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
.time-records { display: flex; align-items: flex-start; justify-content: center; gap: 7rem; padding: 0 2rem; margin-top: -1rem; }
.record-column { min-width: 12rem; }
.record-column h3 { margin-bottom: 1rem; font-weight: 500; }
.record-item { font-size: 1.5rem; font-family: "Departure Mono"; text-shadow: 1px 1px 2px grey; padding: 0.5rem; }
.saved-records { margin-top: 2rem; padding: 1rem; background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); border-radius: 1rem; }
.saved-records h3 { margin-bottom: 1rem; }
.saved-item { font-size: 2rem; font-family: "Departure Mono"; font-weight: bold; color: #2e7d32; padding: 0.3rem; }
input.event-name { width: 15rem; height: 1.5rem; line-height: 1.5rem; }
.match-config div i { margin-right: 0.7rem; }
</style>
