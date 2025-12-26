<script setup>
import { ref, computed, onMounted } from 'vue'
import { useEntryStore } from '../stores/entry'
import { addEntry as apiAddEntry, deleteEntry as apiDeleteEntry } from '../composables/useApi'
import { useNotification } from '../composables/useNotification'

const { notyf } = useNotification()
const entryStore = useEntryStore()

const newEntry = ref({ num: '', univ: '', team: '' })

const currentYear = computed(() => new Date().getFullYear())
const entries = computed(() => entryStore.entries)

onMounted(() => {
  if (!entryStore.isLoaded) entryStore.loadEntries()
})

async function addEntry() {
  if (!newEntry.value.num || !newEntry.value.univ || !newEntry.value.team) {
    return notyf.error('모든 필드를 입력하세요.')
  }

  const num = Number(newEntry.value.num)
  if (isNaN(num) || num <= 0) {
    return notyf.error('번호는 양수여야 합니다.')
  }

  if (entries.value.find(e => e.num === num)) {
    return notyf.error('이미 존재하는 번호입니다.')
  }

  try {
    await apiAddEntry({ num, univ: newEntry.value.univ.trim(), team: newEntry.value.team.trim() })
    notyf.success('엔트리를 추가했습니다.')
    newEntry.value = { num: '', univ: '', team: '' }
    await entryStore.loadEntries()
  } catch (e) {
    notyf.error(`엔트리 추가에 실패했습니다.<br>${e}`)
  }
}

async function deleteEntry(num) {
  if (!confirm(`${num}번 팀을 삭제하시겠습니까?`)) return

  try {
    await apiDeleteEntry(num)
    notyf.success('엔트리를 삭제했습니다.')
    await entryStore.loadEntries()
  } catch (e) {
    notyf.error(`엔트리 삭제에 실패했습니다.<br>${e}`)
  }
}
</script>

<template>
  <div class="container">
    <div class="configuration">
      <h1>📝 엔트리 관리</h1>
      <div class="mode-description">대회 참가 엔트리를 관리합니다.</div>
      <article>
        <h2><i class="fa fw fa-plus"></i>엔트리 추가</h2>
        <div class="add-form">
          <div class="form-row"><label>번호</label><input v-model="newEntry.num" type="number" class="entry-input num" placeholder="01"></div>
          <div class="form-row"><label>학교</label><input v-model="newEntry.univ" type="text" class="entry-input" placeholder="대학교명"></div>
          <div class="form-row"><label>팀명</label><input v-model="newEntry.team" type="text" class="entry-input" placeholder="팀 이름"></div>
          <button class="add-btn btn blue" @click="addEntry"><i class="fa fa-plus"></i> 추가</button>
        </div>
      </article>
    </div>

    <div class="monitor">
      <h1 class="event-title">{{ currentYear }} FSK 엔트리</h1>
      <article class="entry-table-container">
        <table v-if="entries.length > 0" class="entry-table">
          <thead><tr><th>번호</th><th>학교</th><th>팀명</th><th>삭제</th></tr></thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.num">
              <td class="num">{{ entry.num }}</td>
              <td>{{ entry.univ }}</td>
              <td>{{ entry.team }}</td>
              <td><button class="delete-btn btn red small" @click="deleteEntry(entry.num)"><i class="fa fa-trash"></i></button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="no-entries">등록된 엔트리가 없습니다.</p>
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
.monitor article { margin-left: 0; margin-top: 3rem; }
article h2 { font-size: 1.3rem; margin-left: 1rem; margin-bottom: 1rem; }
.configuration article > div { margin-left: 3rem; line-height: 1.7rem; }
.event-title { font-size: 3rem; font-weight: bold; }
.add-form { display: flex; flex-direction: column; gap: 1rem; }
.form-row { display: flex; align-items: center; gap: 1rem; }
.form-row label { width: 3rem; font-weight: 500; }
.entry-input { height: 1.7rem; padding: 0 0.5rem; font-size: 1rem; }
.entry-input.num { width: 4rem; text-align: center; }
.add-btn { margin-top: 0.5rem; align-self: flex-start; }
.entry-table-container { padding: 0 2rem; }
.entry-table { width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse; }
.entry-table th, .entry-table td { padding: 0.7rem 1rem; text-align: left; border-bottom: 1px solid #ddd; }
.entry-table th { background-color: #313443; color: white; font-weight: 500; }
.entry-table tbody tr:hover { background-color: #f5f5f5; }
.entry-table .num { font-weight: bold; text-align: center; }
.delete-btn { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.no-entries { color: #666; font-size: 1.2rem; }
</style>
