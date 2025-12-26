<script setup>
import { ref, onMounted, computed } from 'vue'
import EntryTable from './components/EntryTable.vue'
import EntryForm from './components/EntryForm.vue'
import FileManager from './components/FileManager.vue'
import Toast from './components/Toast.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import NavMenu from './components/NavMenu.vue'
import { fetchEntries, addEntry, updateEntry, deleteEntry, uploadEntries } from './api'

const entries = ref({})
const loading = ref(true)
const toast = ref(null)
const searchQuery = ref('')

const entriesArray = computed(() => {
  return Object.entries(entries.value)
    .map(([num, data]) => ({ num: Number(num), ...data }))
    .sort((a, b) => a.num - b.num)
})

const filteredEntries = computed(() => {
  if (!searchQuery.value.trim()) return entriesArray.value
  const query = searchQuery.value.toLowerCase()
  return entriesArray.value.filter(entry =>
    entry.num.toString().includes(query) ||
    entry.univ.toLowerCase().includes(query) ||
    entry.team.toLowerCase().includes(query)
  )
})

const totalCount = computed(() => entriesArray.value.length)

async function loadEntries() {
  loading.value = true
  try {
    entries.value = await fetchEntries()
  } catch (e) {
    toast.value?.show(e.message, 'error')
  } finally {
    loading.value = false
  }
}

async function handleAdd(entry) {
  try {
    await addEntry(entry)
    toast.value?.show(`${entry.num}번 엔트리를 추가했습니다.`, 'success')
    await loadEntries()
  } catch (e) {
    toast.value?.show(e.message, 'error')
  }
}

async function handleUpdate(entry) {
  try {
    await updateEntry(entry)
    toast.value?.show(`${entry.num}번 엔트리를 수정했습니다.`, 'success')
    await loadEntries()
  } catch (e) {
    toast.value?.show(e.message, 'error')
  }
}

async function handleDelete(num) {
  try {
    await deleteEntry(num)
    toast.value?.show(`${num}번 엔트리를 삭제했습니다.`, 'success')
    await loadEntries()
  } catch (e) {
    toast.value?.show(e.message, 'error')
  }
}

async function handleUpload(data) {
  try {
    await uploadEntries(data)
    toast.value?.show('엔트리 목록을 업로드했습니다.', 'success')
    await loadEntries()
  } catch (e) {
    toast.value?.show(e.message, 'error')
  }
}

onMounted(loadEntries)
</script>

<template>
  <div class="app-container">
    <Toast ref="toast" />
    
    <header class="header">
      <div class="header-content">
        <div class="logo">
          <span class="logo-icon">🏁</span>
          <h1>FSK 엔트리 관리</h1>
        </div>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu />
        </div>
      </div>
    </header>

    <main class="main-content">
      <aside class="sidebar">
        <EntryForm @submit="handleAdd" />
        <FileManager @upload="handleUpload" />
      </aside>

      <section class="content">
        <div class="table-header">
          <div class="table-title-area">
            <h2>엔트리 목록</h2>
            <span class="entry-count">{{ totalCount }}개</span>
          </div>
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
            <input 
              v-model="searchQuery"
              type="text" 
              placeholder="검색..." 
              class="search-input"
            />
          </div>
        </div>
        
        <div v-if="loading" class="loading-container">
          <div class="loading-spinner"></div>
          <p>데이터를 불러오는 중...</p>
        </div>
        
        <EntryTable 
          v-else
          :entries="filteredEntries"
          @update="handleUpdate"
          @delete="handleDelete"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  background: var(--bg-primary);
}

.header {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  padding: 1rem 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.header-content {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.logo-icon {
  font-size: 2rem;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.logo h1 {
  color: white;
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.main-content {
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 2rem;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.content {
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.table-title-area {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.table-title-area h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary);
}

.entry-count {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  width: 18px;
  height: 18px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.search-input {
  padding: 0.5rem 0.75rem 0.5rem 2.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  width: 220px;
  background: var(--bg-primary);
  color: var(--text-primary);
  transition: all 0.2s ease;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1024px) {
  .main-content {
    grid-template-columns: 1fr;
  }
  
  .sidebar {
    flex-direction: row;
    flex-wrap: wrap;
  }
  
  .sidebar > :deep(*) {
    flex: 1;
    min-width: 280px;
  }
}

@media (max-width: 640px) {
  .header {
    padding: 1rem;
  }
  
  .header-content {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }
  
  .main-content {
    padding: 1rem;
  }
  
  .table-header {
    flex-direction: column;
    gap: 1rem;
    align-items: stretch;
  }
  
  .search-input {
    width: 100%;
  }
}
</style>

