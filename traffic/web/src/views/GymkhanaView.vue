<script setup>
import { ref, computed, onMounted, watch } from 'vue'
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
const selectedTeamLane1 = ref(null)
const selectedTeamLane2 = ref(null)
const savedRecords = ref({ 1: null, 2: null })

async function onSensor({ sensor, tick, greenTick }) {
  if (savedRecords.value[sensor]) return

  const entry = sensor === 1 ? entry1.value : entry2.value
  if (!entry) return

  const result = tick - greenTick

  const recordData = {
    time: new Date(),
    type: 'gymkhana',
    lane: String(sensor),
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result,
    detail: '-'
  }

  try {
    await addRecord(eventName.value.trim(), recordData)
    savedRecords.value[sensor] = { result, time: msToClockStr(result) }
    serial.setSensorCooldown(sensor)
    notyf.success(`${sensor}번 레인 기록 저장: ${msToClockStr(result)}`)
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`)
  }
}

onMounted(() => {
  serial.setMode('gymkhana', onSensor)
  if (!entryStore.isLoaded) entryStore.loadEntries()
})

const currentYear = computed(() => new Date().getFullYear())
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim()}`)
const entry1 = computed(() => entryStore.getEntryByNum(selectedTeamLane1.value))
const entry2 = computed(() => entryStore.getEntryByNum(selectedTeamLane2.value))
const entryDisplay1 = computed(() => entry1.value ? `${entry1.value.num} ${entry1.value.univ} ${entry1.value.team}` : '\u200E')
const entryDisplay2 = computed(() => entry2.value ? `${entry2.value.num} ${entry2.value.univ} ${entry2.value.team}` : '\u200E')
const isLocked = computed(() => serial.green.active)
const lane1Records = computed(() => serial.records.filter(r => r.sensor === 1))
const lane2Records = computed(() => serial.records.filter(r => r.sensor === 2))

watch(selectedTeamLane1, (newVal) => {
  if (newVal && newVal === selectedTeamLane2.value) {
    selectedTeamLane1.value = null
    notyf.error('이미 다른 레인에 선택된 팀입니다.')
  }
})

watch(selectedTeamLane2, (newVal) => {
  if (newVal && newVal === selectedTeamLane1.value) {
    selectedTeamLane2.value = null
    notyf.error('이미 다른 레인에 선택된 팀입니다.')
  }
})

function handleConnect() { serial.connect() }
function handleGreen() {
  if (!eventName.value.trim()) return notyf.error('이벤트 이름을 입력하세요.')
  if (!selectedTeamLane1.value && !selectedTeamLane2.value) return notyf.error('참가팀을 선택하세요.')
  savedRecords.value = { 1: null, 2: null }
  serial.sendGreen()
}
function handleRed() { serial.sendRed() }
function handleOff() { serial.sendOff() }
function handleReset() {
  savedRecords.value = { 1: null, 2: null }
  serial.reset()
}
</script>

<template>
  <div class="container">
    <div class="configuration">
      <h1>🏁 짐카나</h1>
      <div class="mode-description">
        2개의 센서를 각 차량의 도착점에 설치합니다.<br>
        녹색등 점등부터 도착점 통과까지의 시간을 자동 저장합니다.
      </div>

      <ControllerConnect :connected="serial.connected" @connect="handleConnect" />
      <TrafficControls :connected="serial.connected" :green-active="serial.green.active" :light-color="serial.lightColor" @green="handleGreen" @red="handleRed" @off="handleOff" />

      <article class="match-config">
        <h2><i class="fa fw fa-calendar-check"></i>경기 설정</h2>
        <div>
          <div>이벤트 이름이 같은 경기는 같은 파일에 기록됩니다.</div>
          <div><i class="fa fa-fw fa-file-signature"></i><input v-model="eventName" class="event-name" placeholder="이벤트 이름" :disabled="isLocked"></div>
        </div>
        <div>
          <TeamSelect v-model="selectedTeamLane1" label="1" :disabled="isLocked" />
          <TeamSelect v-model="selectedTeamLane2" label="2" :disabled="isLocked" />
        </div>
        <div>
          <span class="btn orange" :class="{ disabled: !serial.records.length }" @click="handleReset"><i class="fa fw fa-rotate-left"></i>초기화</span>
        </div>
      </article>
    </div>

    <div class="monitor">
      <h1 class="event-title">{{ titleText }}</h1>
      <article class="time"><TrafficLight :color="serial.lightColor" /><Clock :time="serial.clockDisplay" /></article>
      <article class="lanes">
        <div v-if="selectedTeamLane1" class="lane">
          <div class="entry-team">{{ entryDisplay1 }}</div>
          <div class="lane-records"><div v-for="(r, i) in lane1Records" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div></div>
          <div v-if="savedRecords[1]" class="saved-badge">💾 {{ savedRecords[1].time }}</div>
        </div>
        <div v-if="selectedTeamLane2" class="lane">
          <div class="entry-team">{{ entryDisplay2 }}</div>
          <div class="lane-records"><div v-for="(r, i) in lane2Records" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div></div>
          <div v-if="savedRecords[2]" class="saved-badge">💾 {{ savedRecords[2].time }}</div>
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
.entry-team { font-size: 2rem; font-weight: 500; font-style: italic; font-family: "MonoplexKR"; word-break: keep-all; margin-bottom: 1rem; }
.lanes { display: flex; justify-content: center; gap: 4rem; padding: 0 2rem; }
.lane { min-width: 15rem; padding: 1rem; }
.lane-records { min-height: 3rem; }
.record-item { font-size: 1.5rem; font-family: "Departure Mono"; text-shadow: 1px 1px 2px grey; padding: 0.3rem; }
.saved-badge { margin-top: 1rem; padding: 0.8rem 1.2rem; background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); border-radius: 0.8rem; font-size: 1.8rem; font-family: "Departure Mono"; font-weight: bold; color: #2e7d32; }
input.event-name { width: 15rem; height: 1.5rem; line-height: 1.5rem; }
.match-config div i { margin-right: 0.7rem; }
</style>
