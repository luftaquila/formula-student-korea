<script setup>
import { ref, onMounted, computed, watch } from "vue";
import EntryTable from "./components/EntryTable.vue";
import EntryForm from "./components/EntryForm.vue";
import FileManager from "./components/FileManager.vue";
import VehicleTypeManager from "./components/VehicleTypeManager.vue";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { fetchYears, fetchEntries, addEntry, updateEntry, setEntryActive, uploadEntries, fetchVehicleTypes, addVehicleType, updateVehicleType, deleteVehicleType } from "./api";
import { useNotification } from "@shared/useNotification.js";
import { competitionTeamWriteYears } from "@shared/competition-year.mjs";
import { usePersistentTypeFilters } from "@shared/usePersistentTypeFilters.js";

const { success, error } = useNotification();
const entries = ref({});
const loading = ref(true);
const addingEntry = ref(false);
const searchQuery = ref("");
const teamWriteYears = competitionTeamWriteYears();
const selectedYear = ref(teamWriteYears[0]);
const availableYears = ref(teamWriteYears);
const vehicleTypes = ref([]);
const activeUpdating = ref(new Set());
const rosterReadOnly = computed(() => !teamWriteYears.includes(selectedYear.value));
const refreshNotice = " 열려 있는 Queue·Inspection·Traffic 화면을 새로고침하세요.";

const errorMessage = (e) => e?.data?.message || e?.message || "요청을 처리할 수 없습니다.";
const entriesArray = computed(() => Object.entries(entries.value)
  .map(([num, data]) => ({ num: Number(num), ...data })).sort((a, b) => a.num - b.num));
const availableTypes = computed(() => [...new Set([
  ...vehicleTypes.value.map((type) => type.name),
  ...entriesArray.value.map((entry) => entry.type),
].filter(Boolean))]);
const typeFilters = usePersistentTypeFilters("entry-team-type-filter", availableTypes);
const filteredEntries = computed(() => {
  const typeFiltered = entriesArray.value.filter(
    (entry) => !entry.type || typeFilters.value[entry.type] !== false,
  );
  if (!searchQuery.value.trim()) return typeFiltered;
  const query = searchQuery.value.toLowerCase();
  return typeFiltered.filter((entry) => entry.num.toString().includes(query)
    || entry.univ.toLowerCase().includes(query) || entry.team.toLowerCase().includes(query)
    || entry.type?.toLowerCase().includes(query));
});
const totalCount = computed(() => entriesArray.value.length);
const activeCount = computed(() => entriesArray.value.filter((entry) => entry.active !== false).length);
const inactiveCount = computed(() => totalCount.value - activeCount.value);
const typeCounts = computed(() => {
  const counts = {};
  for (const entry of entriesArray.value.filter((candidate) => candidate.active !== false)) {
    if (entry.type) counts[entry.type] = (counts[entry.type] || 0) + 1;
  }
  return vehicleTypes.value.filter((type) => counts[type.name])
    .map((type) => ({ name: type.name, color: type.color, count: counts[type.name] }));
});
function getTypeColor(type) {
  return vehicleTypes.value.find((candidate) => candidate.name === type)?.color || "blue";
}

async function loadYears() {
  try {
    const storedYears = await fetchYears();
    availableYears.value = [
      ...teamWriteYears,
      ...storedYears.filter((year) => !teamWriteYears.includes(year)),
    ];
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) selectedYear.value = availableYears.value[0];
  } catch (e) { error(errorMessage(e)); }
}
async function loadEntries() {
  const year = selectedYear.value;
  loading.value = true;
  try {
    const loaded = await fetchEntries(year);
    if (selectedYear.value === year) entries.value = loaded;
  }
  catch (e) { if (selectedYear.value === year) error(errorMessage(e)); }
  finally { if (selectedYear.value === year) loading.value = false; }
}
async function loadVehicleTypes() {
  const year = selectedYear.value;
  try {
    const loaded = await fetchVehicleTypes(year);
    if (selectedYear.value === year) vehicleTypes.value = loaded;
  }
  catch (e) { if (selectedYear.value === year) error(errorMessage(e)); }
}
async function handleAdd(entry) {
  addingEntry.value = true;
  const type = vehicleTypes.value.find((candidate) => candidate.name === entry.type);
  try { await addEntry({ ...entry, vehicleTypeId: type?.id ?? null }, selectedYear.value); success(`${entry.num}번 엔트리를 추가했습니다.${refreshNotice}`); await loadEntries(); }
  catch (e) { error(errorMessage(e)); }
  finally { addingEntry.value = false; }
}
async function handleUpdate(entry) {
  const type = vehicleTypes.value.find((candidate) => candidate.name === entry.type);
  try { await updateEntry({ ...entry, vehicleTypeId: type?.id ?? null }); success(`${entry.num}번 엔트리를 수정했습니다.${refreshNotice}`); await loadEntries(); }
  catch (e) { error(errorMessage(e)); }
}
async function handleActive(entry) {
  if (!entry.active && !window.confirm(
    "이 팀을 비활성화하면 진행 중인 대기열·검차·측정 상태가 정리됩니다. 계속하시겠습니까?",
  )) return;
  activeUpdating.value = new Set(activeUpdating.value).add(entry.num);
  try {
    await setEntryActive(entry.id, entry.active);
    success(`${entry.num}번 엔트리를 ${entry.active ? "활성화" : "비활성화"}했습니다.${refreshNotice}`);
    const current = entries.value[entry.num];
    if (current) {
      entries.value = { ...entries.value, [entry.num]: { ...current, active: entry.active } };
    }
  } catch (e) { error(errorMessage(e)); }
  finally { const next = new Set(activeUpdating.value); next.delete(entry.num); activeUpdating.value = next; }
}
async function handleUpload(data) {
  try {
    await uploadEntries(data, selectedYear.value);
    success(`엔트리 목록을 업로드했습니다.${refreshNotice}`);
    await loadEntries();
    return true;
  } catch (e) {
    error(errorMessage(e));
    return false;
  }
}
async function handleAddType({ name, color }) {
  try { await addVehicleType(name, color, selectedYear.value); success(`차량 유형 '${name}'을(를) 추가했습니다.`); await loadVehicleTypes(); }
  catch (e) { error(errorMessage(e)); }
}
async function handleUpdateType({ id, ...data }) {
  try {
    await updateVehicleType(id, data, selectedYear.value);
    success(`차량 유형을 수정했습니다.${refreshNotice}`);
    await Promise.all([loadVehicleTypes(), loadEntries()]);
  }
  catch (e) { error(errorMessage(e)); }
}
async function handleDeleteType(id) {
  try { await deleteVehicleType(id, selectedYear.value); success("차량 유형을 삭제했습니다."); await Promise.all([loadVehicleTypes(), loadEntries()]); }
  catch (e) { error(errorMessage(e)); }
}

watch(selectedYear, () => {
  loadEntries();
  loadVehicleTypes();
});
onMounted(async () => { await loadYears(); await Promise.all([loadEntries(), loadVehicleTypes()]); });
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
        <fieldset class="roster-editor" :disabled="rosterReadOnly">
          <EntryForm :vehicle-types="vehicleTypes" :loading="addingEntry" @submit="handleAdd" />
          <FileManager
            :year="selectedYear"
            :allow-upload="!rosterReadOnly && totalCount === 0"
            :upload="handleUpload"
          />
          <VehicleTypeManager :vehicle-types="vehicleTypes" @add="handleAddType" @update="handleUpdateType" @delete="handleDeleteType" />
        </fieldset>
      </aside>

      <section class="content team-table-card">
        <div class="table-header">
          <div class="table-title-area">
            <div class="title-row">
              <h2>엔트리 목록</h2>
              <select v-model.number="selectedYear" class="year-select">
                <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
              </select>
              <span class="entry-count" title="활성 엔트리">{{ activeCount }}대</span>
              <span v-if="rosterReadOnly" class="roster-badge">읽기 전용</span>
              <span v-if="inactiveCount" class="inactive-count">비활성 {{ inactiveCount }}대</span>
            </div>
            <div v-if="availableTypes.length" class="team-type-filter" data-testid="entry-team-type-filter">
              <label v-for="type in availableTypes" :key="type" class="team-type-filter-label">
                <input v-model="typeFilters[type]" type="checkbox" :value="type" />
                <span class="type-count" :class="'badge-type-' + getTypeColor(type)">
                  {{ type }} {{ typeCounts.find((item) => item.name === type)?.count || 0 }}대
                </span>
              </label>
            </div>
          </div>
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input v-model="searchQuery" type="text" placeholder="엔트리 / 학교 / 팀명" class="search-input" />
          </div>
        </div>

        <div v-if="loading" class="loading-container">
          <div class="loading-spinner"></div>
          <p>데이터를 불러오는 중...</p>
        </div>

        <EntryTable v-else :entries="filteredEntries" :vehicle-types="vehicleTypes" :active-updating="activeUpdating" :readonly="rosterReadOnly" @update="handleUpdate" @active="handleActive" />
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

.roster-editor {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.roster-editor:disabled {
  opacity: 0.6;
}

.roster-badge {
  border: 1px solid #d97706;
  color: #d97706;
  border-radius: 12px;
  padding: 0.2rem 0.55rem;
  font-size: 0.75rem;
  font-weight: 600;
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

.inactive-count {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
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
    gap: 0.75rem;
    align-items: stretch;
    padding: 0.875rem;
  }

  .table-title-area {
    min-width: 0;
  }

  .title-row,
  .team-type-filter {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .title-row::-webkit-scrollbar,
  .team-type-filter::-webkit-scrollbar {
    display: none;
  }

  .title-row {
    gap: 0.375rem;
  }

  .title-row > *,
  .team-type-filter-label {
    flex: 0 0 auto;
  }

  .table-title-area h2 {
    font-size: 1rem;
    white-space: nowrap;
  }

  .year-select,
  .entry-count,
  .inactive-count,
  .roster-badge {
    font-size: 0.6875rem;
    padding: 0.1875rem 0.375rem;
  }

  .team-type-filter {
    gap: 0.375rem;
  }

  .team-type-filter-label {
    min-height: 1.75rem;
  }

  .desktop-only { display: none; }
  .mobile-only { display: flex; }

  .search-input {
    width: 100%;
  }
}
</style>
