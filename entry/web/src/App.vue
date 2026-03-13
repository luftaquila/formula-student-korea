<script setup>
import { ref, onMounted, computed, watch } from "vue";
import EntryTable from "./components/EntryTable.vue";
import EntryForm from "./components/EntryForm.vue";
import FileManager from "./components/FileManager.vue";
import VehicleTypeManager from "./components/VehicleTypeManager.vue";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";
import { fetchYears, fetchEntries, addEntry, updateEntry, deleteEntry, deleteAllEntries, uploadEntries, fetchVehicleTypes, addVehicleType, deleteVehicleType } from "./api";
import { useNotification } from "./composables/useNotification";

const { success, error } = useNotification();

const entries = ref({});
const loading = ref(true);
const searchQuery = ref("");
const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const vehicleTypes = ref([]);

const entriesArray = computed(() => {
  return Object.entries(entries.value)
    .map(([num, data]) => ({ num: Number(num), ...data }))
    .sort((a, b) => a.num - b.num);
});

const filteredEntries = computed(() => {
  if (!searchQuery.value.trim()) return entriesArray.value;
  const query = searchQuery.value.toLowerCase();
  return entriesArray.value.filter(
    (entry) =>
      entry.num.toString().includes(query) ||
      entry.univ.toLowerCase().includes(query) ||
      entry.team.toLowerCase().includes(query) ||
      entry.type?.toLowerCase().includes(query),
  );
});

const totalCount = computed(() => entriesArray.value.length);

async function loadYears() {
  try {
    availableYears.value = await fetchYears();
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
  } catch (e) {
    error(e.message);
  }
}

async function loadEntries() {
  loading.value = true;
  try {
    entries.value = await fetchEntries(selectedYear.value);
  } catch (e) {
    error(e.message);
  } finally {
    loading.value = false;
  }
}

async function handleAdd(entry) {
  try {
    await addEntry(entry, selectedYear.value);
    success(`${entry.num}번 엔트리를 추가했습니다.`);
    await loadEntries();
  } catch (e) {
    error(e.message);
  }
}

async function handleUpdate(entry) {
  try {
    await updateEntry(entry, selectedYear.value);
    success(`${entry.num}번 엔트리를 수정했습니다.`);
    await loadEntries();
  } catch (e) {
    error(e.message);
  }
}

async function handleDelete(num) {
  try {
    await deleteEntry(num, selectedYear.value);
    success(`${num}번 엔트리를 삭제했습니다.`);
    await loadEntries();
  } catch (e) {
    error(e.message);
  }
}

async function handleUpload(data) {
  try {
    await uploadEntries(data, selectedYear.value);
    success("엔트리 목록을 업로드했습니다.");
    await loadEntries();
  } catch (e) {
    error(e.message);
  }
}

async function handleDeleteAll() {
  try {
    await deleteAllEntries(selectedYear.value);
    success("모든 엔트리를 삭제했습니다.");
    await loadEntries();
  } catch (e) {
    error(e.message);
  }
}

async function loadVehicleTypes() {
  try {
    vehicleTypes.value = await fetchVehicleTypes();
  } catch (e) {
    error(e.message);
  }
}

async function handleAddType(name) {
  try {
    await addVehicleType(name);
    success(`차량 유형 '${name}'을(를) 추가했습니다.`);
    await loadVehicleTypes();
  } catch (e) {
    error(e.message);
  }
}

async function handleDeleteType(id) {
  try {
    await deleteVehicleType(id);
    success("차량 유형을 삭제했습니다.");
    await Promise.all([loadVehicleTypes(), loadEntries()]);
  } catch (e) {
    error(e.message);
  }
}

watch(selectedYear, loadEntries);

onMounted(async () => {
  await loadYears();
  await Promise.all([loadEntries(), loadVehicleTypes()]);
});
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🏁</span>
          <h1>FSK 엔트리 관리</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu currentPath="/entry" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <aside class="sidebar">
        <EntryForm :vehicle-types="vehicleTypes" @submit="handleAdd" />
        <FileManager :year="selectedYear" @upload="handleUpload" @delete-all="handleDeleteAll" />
        <VehicleTypeManager :vehicle-types="vehicleTypes" @add="handleAddType" @delete="handleDeleteType" />
      </aside>

      <section class="content">
        <div class="table-header">
          <div class="table-title-area">
            <h2>엔트리 목록</h2>
            <select v-model.number="selectedYear" class="year-select">
              <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
            </select>
            <span class="entry-count">{{ totalCount }}개</span>
          </div>
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input v-model="searchQuery" type="text" placeholder="검색..." class="search-input" />
          </div>
        </div>

        <div v-if="loading" class="loading-container">
          <div class="loading-spinner"></div>
          <p>데이터를 불러오는 중...</p>
        </div>

        <EntryTable v-else :entries="filteredEntries" :vehicle-types="vehicleTypes" @update="handleUpdate" @delete="handleDelete" />
      </section>
    </main>
  </div>
</template>

<style scoped>
.main-content {
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

.year-select {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.year-select:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.entry-count {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
  font-family: "JetBrains Mono", monospace;
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
  to {
    transform: rotate(360deg);
  }
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
