<script setup>
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { fetchEntries, fetchEntryYears, fetchSheetSummary } from "../api";
import { useNotification } from "../composables/useNotification";

const { error } = useNotification();
const router = useRouter();

const entries = ref({});
const summary = ref({ categories: [], teams: {} });
const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const loading = ref(true);
const searchQuery = ref("");

const isReadOnly = computed(() => selectedYear.value < new Date().getFullYear());

const filteredEntries = computed(() => {
  const list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  if (!searchQuery.value) return list.sort((a, b) => a.num - b.num);
  const q = searchQuery.value.toLowerCase();
  return list
    .filter(e => String(e.num).includes(q) || (e.univ || "").toLowerCase().includes(q) || (e.team || "").toLowerCase().includes(q))
    .sort((a, b) => a.num - b.num);
});

onMounted(async () => {
  try {
    availableYears.value = await fetchEntryYears();
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
    await loadData();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
});

async function loadData() {
  try {
    const [e, s] = await Promise.all([
      fetchEntries(selectedYear.value),
      fetchSheetSummary(selectedYear.value),
    ]);
    entries.value = e;
    summary.value = s;
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
}

async function onYearChange() {
  loading.value = true;
  await loadData();
  loading.value = false;
}

function goToSheet(num) {
  router.push(`/${selectedYear.value}/${num}`);
}

function getResult(num, catId) {
  return summary.value.teams[num]?.results?.[catId] || "";
}

function getInspector(num, catId) {
  return summary.value.teams[num]?.inspectors?.[catId] || "";
}
</script>

<template>
  <div class="sheet-list-page">
    <div class="top-actions">
      <button class="btn btn-ghost" @click="router.push('/template')">템플릿 관리</button>
    </div>

    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label">엔트리</label>
        <select class="filter-input" v-model.number="selectedYear" @change="onYearChange">
          <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">검색</label>
        <input class="filter-input" v-model="searchQuery" placeholder="번호 / 학교 / 팀명" />
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <div class="card">
      <div class="card-header">
        <div class="header-left">
          <h3>검차 시트</h3>
          <span class="count-badge">{{ filteredEntries.length }}개 팀</span>
        </div>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="table-container">
          <table class="data-table sheet-table">
            <thead>
              <tr>
                <th class="col-num">번호</th>
                <th class="col-team">학교 / 팀</th>
                <template v-for="cat in summary.categories" :key="'r'+cat.id">
                  <th class="col-result">{{ cat.name }}</th>
                </template>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in filteredEntries"
                :key="entry.num"
                class="clickable-row"
                @click="goToSheet(entry.num)"
              >
                <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                <td class="col-team"><span class="entry-name">{{ entry.univ }} {{ entry.team }}</span></td>
                <template v-for="cat in summary.categories" :key="'r'+cat.id+'-'+entry.num">
                  <td class="col-result">
                    <span
                      v-if="getResult(entry.num, cat.id)"
                      class="badge"
                      :class="getResult(entry.num, cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
                    >{{ getResult(entry.num, cat.id) }}</span>
                    <span v-else class="badge badge-empty">-</span>
                    <span v-if="getInspector(entry.num, cat.id)" class="inspector-name">({{ getInspector(entry.num, cat.id) }})</span>
                  </td>
                </template>
              </tr>
              <tr v-if="filteredEntries.length === 0">
                <td :colspan="2 + summary.categories.length" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-list-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.top-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.filter-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.filter-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  background: var(--bg-input);
  color: var(--text-primary);
}

.filter-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.readonly-banner {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning);
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.875rem;
  text-align: center;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.count-badge {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
}

.table-body {
  padding: 0 !important;
  overflow: auto;
}

.table-container {
  overflow-x: auto;
}

.sheet-table {
  min-width: 600px;
}

.sheet-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  white-space: nowrap;
  font-size: 0.75rem;
}

.col-num {
  width: 60px;
  text-align: center !important;
}

.col-team {
  min-width: 150px;
}

.col-result {
  min-width: 100px;
  text-align: center !important;
}

.inspector-name {
  display: block;
  font-size: 0.6875rem;
  color: var(--text-tertiary);
  margin-top: 0.125rem;
}

.entry-num {
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
}

.entry-name {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}

.clickable-row:hover {
  background: var(--bg-hover);
}

.badge-empty {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.loading {
  display: flex;
  justify-content: center;
  padding: 3rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

@media (max-width: 640px) {
  .filter-bar {
    flex-direction: column;
  }

  .filter-input {
    width: 100%;
  }
}
</style>
