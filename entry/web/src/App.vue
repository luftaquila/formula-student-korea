<script setup>
import { ref, onMounted, computed, watch } from "vue";
import EntryTable from "./components/EntryTable.vue";
import EntryForm from "./components/EntryForm.vue";
import FileManager from "./components/FileManager.vue";
import VehicleTypeManager from "./components/VehicleTypeManager.vue";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { fetchYears, fetchEntries, addEntry, updateEntry, deleteEntry, deleteAllEntries, uploadEntries, fetchVehicleTypes, addVehicleType, updateVehicleType, deleteVehicleType } from "./api";
import { useNotification } from "@shared/useNotification.js";

const { success, error } = useNotification();

const entries = ref({});
const loading = ref(true);
const addingEntry = ref(false);
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

const typeCounts = computed(() => {
  const counts = {};
  for (const e of entriesArray.value) {
    const t = e.type || null;
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  return vehicleTypes.value
    .filter(vt => counts[vt.name])
    .map(vt => ({ name: vt.name, color: vt.color, count: counts[vt.name] }));
});

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
  addingEntry.value = true;
  try {
    await addEntry(entry, selectedYear.value);
    success(`${entry.num}번 엔트리를 추가했습니다.`);
    await loadEntries();
  } catch (e) {
    error(e.message);
  } finally {
    addingEntry.value = false;
  }
}

async function handleUpdate(entry) {
  try {
    await updateEntry(entry, selectedYear.value);
    success(`${entry.num}번 엔트리를 수정했습니다.`);
    entries.value = await fetchEntries(selectedYear.value);
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

async function handleUpload(data, intents) {
  try {
    await uploadEntries(data, selectedYear.value, intents);
    success("엔트리 목록을 업로드했습니다.");
    await loadEntries();
  } catch (e) {
    // 동일 번호에서 팀이 바뀐 항목은 명칭 정정인지 팀 교체인지 운영자가 정해야
    // downstream(제출·점수·검차) 데이터를 유지할지 삭제할지 결정할 수 있다.
    if (e.ambiguous) {
      const replacements = [];
      const retains = [];
      for (const c of e.ambiguous) {
        const keep = confirm(
          `${c.num}번 엔트리의 팀이 변경되었습니다.\n\n` +
            `기존: ${c.from.univ} ${c.from.team}\n` +
            `신규: ${c.to.univ} ${c.to.team}\n\n` +
            `같은 팀의 이름을 정정한 것입니까?\n\n` +
            `[확인] 명칭 정정 — 기존 제출/점수/검차 데이터를 유지합니다.\n` +
            `[취소] 팀 교체 — 기존 ${c.num}번 데이터를 삭제합니다.`,
        );
        if (keep) retains.push(c.num);
        else replacements.push(c.num);
      }
      return handleUpload(data, { replacements, retains });
    }
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
    vehicleTypes.value = await fetchVehicleTypes(selectedYear.value);
  } catch (e) {
    error(e.message);
  }
}

async function handleAddType({ name, color }) {
  try {
    await addVehicleType(name, color, selectedYear.value);
    success(`차량 유형 '${name}'을(를) 추가했습니다.`);
    await loadVehicleTypes();
  } catch (e) {
    error(e.message);
  }
}

async function handleUpdateType({ id, ...data }) {
  try {
    await updateVehicleType(id, data, selectedYear.value);
    await Promise.all([loadVehicleTypes(), loadEntries()]);
  } catch (e) {
    error(e.message);
  }
}

async function handleDeleteType(id) {
  try {
    await deleteVehicleType(id, selectedYear.value);
    success("차량 유형을 삭제했습니다.");
    await Promise.all([loadVehicleTypes(), loadEntries()]);
  } catch (e) {
    error(e.message);
  }
}

watch(selectedYear, () => { loadEntries(); loadVehicleTypes(); });

onMounted(async () => {
  await loadYears();
  await Promise.all([loadEntries(), loadVehicleTypes()]);
});
</script>

<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🏁</span>
          <h1>FSK 엔트리 관리</h1>
        </a>
        <div class="header-actions">
          <NavMenu currentPath="/entry" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <aside class="sidebar">
        <EntryForm :vehicle-types="vehicleTypes" :loading="addingEntry" @submit="handleAdd" />
        <FileManager :year="selectedYear" @upload="handleUpload" @delete-all="handleDeleteAll" />
        <VehicleTypeManager :vehicle-types="vehicleTypes" @add="handleAddType" @update="handleUpdateType" @delete="handleDeleteType" />
      </aside>

      <section class="content">
        <div class="table-header">
          <div class="table-title-area">
            <div class="title-row">
              <h2>엔트리 목록</h2>
              <select v-model.number="selectedYear" class="year-select">
                <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
              </select>
              <span class="entry-count">{{ totalCount }}대</span>
              <span v-for="tc in typeCounts" :key="tc.name" class="type-count desktop-only" :class="'badge-type-' + tc.color">{{ tc.name }} {{ tc.count }}대</span>
            </div>
            <div v-if="typeCounts.length" class="type-counts-row mobile-only">
              <span v-for="tc in typeCounts" :key="tc.name" class="type-count" :class="'badge-type-' + tc.color">{{ tc.name }} {{ tc.count }}대</span>
            </div>
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
  border-radius: 12px;
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
  flex-direction: column;
  gap: 0.5rem;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.type-counts-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.mobile-only { display: none; }

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
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.1);
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

.type-count {
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
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
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.1);
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

  .desktop-only { display: none; }
  .mobile-only { display: flex; }

  .search-input {
    width: 100%;
  }
}
</style>
