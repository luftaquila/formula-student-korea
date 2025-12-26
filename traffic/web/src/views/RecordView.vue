<script setup>
import { ref, onMounted, computed } from 'vue'
import { fetchRecords, fetchRecord } from '../composables/useApi'
import { useNotification } from '../composables/useNotification'
import { msToClockStr } from '../stores/serial'

const { notyf } = useNotification()

const recordFiles = ref([])
const selectedFile = ref(null)
const records = ref([])
const loading = ref(false)

const currentYear = computed(() => new Date().getFullYear())

onMounted(async () => {
  await loadFileList()
})

async function loadFileList() {
  try {
    recordFiles.value = await fetchRecords()
  } catch (e) {
    notyf.error(`기록 목록을 불러오지 못했습니다.<br>${e}`)
  }
}

async function loadRecords() {
  if (!selectedFile.value) return

  loading.value = true
  try {
    records.value = await fetchRecord(selectedFile.value)
  } catch (e) {
    notyf.error(`기록을 불러오지 못했습니다.<br>${e}`)
    records.value = []
  } finally {
    loading.value = false
  }
}

function formatTime(time) {
  return new Date(time).toLocaleString('ko-KR')
}

function formatResult(result) {
  return msToClockStr(result)
}
</script>

<template>
  <div class="container">
    <div class="configuration">
      <h1>📋 경기 기록</h1>
      <div class="mode-description">저장된 경기 기록을 조회합니다.</div>
      <article>
        <h2><i class="fa fw fa-folder-open"></i>기록 파일</h2>
        <div>
          <select v-model="selectedFile" class="file-select" @change="loadRecords">
            <option disabled :value="null">파일 선택</option>
            <option v-for="file in recordFiles" :key="file" :value="file">{{ file }}</option>
          </select>
        </div>
      </article>
    </div>

    <div class="monitor">
      <h1 class="event-title">{{ currentYear }} FSK 기록</h1>
      <article v-if="loading" class="loading"><i class="fa fa-spinner fa-spin"></i> 로딩 중...</article>
      <article v-else-if="records.length > 0" class="records-table-container">
        <table class="records-table">
          <thead>
            <tr><th>시간</th><th>번호</th><th>학교</th><th>팀</th><th>유형</th><th>레인</th><th>기록</th><th>상세</th></tr>
          </thead>
          <tbody>
            <tr v-for="(record, index) in records" :key="index">
              <td>{{ formatTime(record.time) }}</td>
              <td>{{ record.num }}</td>
              <td>{{ record.univ }}</td>
              <td>{{ record.team }}</td>
              <td>{{ record.type }}</td>
              <td>{{ record.lane }}</td>
              <td class="result">{{ formatResult(record.result) }}</td>
              <td>{{ record.detail }}</td>
            </tr>
          </tbody>
        </table>
      </article>
      <article v-else class="no-records"><p>기록 파일을 선택하세요.</p></article>
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
.monitor article { margin-left: 0; margin-top: 3rem; }
article h2 { font-size: 1.3rem; margin-left: 1rem; margin-bottom: 1rem; }
.configuration article > div { margin-left: 3rem; line-height: 1.7rem; }
.event-title { font-size: 3rem; font-weight: bold; }
.file-select { width: 20rem; height: 2rem; font-size: 1rem; }
.records-table-container { overflow-x: auto; padding: 0 1rem; }
.records-table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
.records-table th, .records-table td { padding: 0.7rem 1rem; text-align: left; border-bottom: 1px solid #ddd; }
.records-table th { background-color: #313443; color: white; font-weight: 500; }
.records-table tbody tr:hover { background-color: #f5f5f5; }
.records-table .result { font-family: "Departure Mono"; font-weight: bold; }
.loading, .no-records { font-size: 1.2rem; color: #666; }
</style>
