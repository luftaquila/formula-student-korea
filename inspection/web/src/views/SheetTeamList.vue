<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import { fetchEntries, fetchEntryYears, fetchSheetSummary, fetchVehicleTypes } from "../api";
import { useNotification } from "@shared/useNotification.js";
import { useSSE } from "../composables/useSSE";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { isChief } from "@shared/officialsStore.js";

const tableRef = ref(null);
const { error } = useNotification();
const router = useRouter();
const { lastUpdate, lastInspectorUpdate, lastEntriesUpdate } = useSSE();

const entries = ref({});
const summary = ref({ categories: [], teams: {} });
const selectedYear = ref(currentCompetitionYear());
const availableYears = ref([]);
const typeColorMap = ref({});
const vehicleTypes = ref([]);
const loading = ref(true);
const searchQuery = ref("");
const TYPE_FILTER_STORAGE_KEY = "inspection-team-type-filter";
const storedTypeFilter = localStorage.getItem(TYPE_FILTER_STORAGE_KEY);
let legacySelectedType = "";
let initialTypeFilters = {};
if (storedTypeFilter) {
  try {
    const parsed = JSON.parse(storedTypeFilter);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      initialTypeFilters = Object.fromEntries(
        Object.entries(parsed).filter(([, enabled]) => typeof enabled === "boolean"),
      );
    } else {
      legacySelectedType = typeof parsed === "string" ? parsed : storedTypeFilter;
    }
  } catch {
    legacySelectedType = storedTypeFilter;
  }
}
const typeFilters = ref(initialTypeFilters);
const tableScrollLeft = ref(0);
const stickyHeaderMetrics = ref({ width: 0, height: 0, columnWidths: [] });
let lifecycleRefreshTimer = null;
let dataLoadSeq = 0;
let stickyHeaderResizeObserver = null;
const INSPECTOR_COLLAPSE_THRESHOLD = 5;
const MOBILE_ENTRY_COLUMN_WIDTH = 148;
const MOBILE_RESULT_COLUMN_WIDTH = 104;

const isReadOnly = computed(() => selectedYear.value !== currentCompetitionYear());
const mobileTableWidth = computed(() => `${MOBILE_ENTRY_COLUMN_WIDTH + summary.value.categories.length * MOBILE_RESULT_COLUMN_WIDTH}px`);
const stickyHeaderHostStyle = computed(() => {
  const height = stickyHeaderMetrics.value.height;
  return {
    height: `${height}px`,
    marginBottom: `-${height}px`,
  };
});
const stickyHeaderRowStyle = computed(() => ({
  width: `${stickyHeaderMetrics.value.width}px`,
  transform: `translate3d(-${tableScrollLeft.value}px, 0, 0)`,
}));
const availableTypes = computed(() => {
  const configured = vehicleTypes.value.map(type => type.name).filter(Boolean);
  const used = Object.values(entries.value).map(entry => entry.type).filter(Boolean);
  return [...new Set([...configured, ...used])];
});

const filteredEntries = computed(() => {
  const list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  const typeFiltered = list.filter(entry => !entry.type || typeFilters.value[entry.type] !== false);
  if (!searchQuery.value) return typeFiltered.sort((a, b) => a.num - b.num);
  const q = searchQuery.value.toLowerCase();
  return typeFiltered
    .filter(e => String(e.num).includes(q) || (e.univ || "").toLowerCase().includes(q) || (e.team || "").toLowerCase().includes(q))
    .sort((a, b) => a.num - b.num);
});

watch(typeFilters, (filters) => {
  localStorage.setItem(TYPE_FILTER_STORAGE_KEY, JSON.stringify(filters));
}, { deep: true });

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

function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
}

async function loadData() {
  const seq = ++dataLoadSeq;
  try {
    const [e, s, vtList] = await Promise.all([
      fetchEntries(selectedYear.value),
      fetchSheetSummary(selectedYear.value),
      fetchVehicleTypes(selectedYear.value).catch(() => []),
    ]);
    if (seq !== dataLoadSeq) return;
    entries.value = e;
    summary.value = s;
    vehicleTypes.value = vtList;
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
    const types = availableTypes.value;
    const legacyTypeAvailable = legacySelectedType && types.includes(legacySelectedType);
    for (const type of types) {
      if (legacySelectedType) typeFilters.value[type] = !legacyTypeAvailable || type === legacySelectedType;
      else if (!(type in typeFilters.value)) typeFilters.value[type] = true;
    }
    legacySelectedType = "";
  } catch (e) {
    if (seq !== dataLoadSeq) return;
    error("데이터를 가져올 수 없습니다.");
  }
}

async function onYearChange() {
  loading.value = true;
  await loadData();
  loading.value = false;
}

function scheduleLifecycleRefresh() {
  clearTimeout(lifecycleRefreshTimer);
  lifecycleRefreshTimer = setTimeout(() => {
    loadData();
  }, 100);
}

onBeforeUnmount(() => {
  clearTimeout(lifecycleRefreshTimer);
  stickyHeaderResizeObserver?.disconnect();
});

function syncStickyHeaderMetrics() {
  const table = tableRef.value;
  if (!table) return;
  const header = table.querySelector("thead");
  const columnWidths = Array.from(header?.querySelectorAll("th") || [], cell => cell.getBoundingClientRect().width);
  const next = {
    width: table.getBoundingClientRect().width,
    height: header?.getBoundingClientRect().height || 0,
    columnWidths,
  };
  const current = stickyHeaderMetrics.value;
  if (
    Math.abs(current.width - next.width) < 0.5
    && Math.abs(current.height - next.height) < 0.5
    && current.columnWidths.length === next.columnWidths.length
    && current.columnWidths.every((width, index) => Math.abs(width - next.columnWidths[index]) < 0.5)
  ) return;
  stickyHeaderMetrics.value = next;
}

watch(tableRef, async (table) => {
  stickyHeaderResizeObserver?.disconnect();
  stickyHeaderResizeObserver = null;
  if (!table) return;
  await nextTick();
  syncStickyHeaderMetrics();
  stickyHeaderResizeObserver = new ResizeObserver(syncStickyHeaderMetrics);
  stickyHeaderResizeObserver.observe(table);
  const header = table.querySelector("thead");
  if (header) stickyHeaderResizeObserver.observe(header);
}, { flush: "post" });

function onTableScroll(event) {
  tableScrollLeft.value = event.currentTarget.scrollLeft;
}

function getStickyHeaderCellStyle(index) {
  const width = stickyHeaderMetrics.value.columnWidths[index] || 0;
  const style = {
    width: `${width}px`,
    flexBasis: `${width}px`,
  };
  if (index === 0) {
    style.transform = `translate3d(${tableScrollLeft.value}px, 0, 0)`;
    style.zIndex = 2;
  }
  return style;
}

function goToSheet(num) {
  router.push(`/${selectedYear.value}/${num}`);
}

function goToCategory(num, categoryId) {
  router.push({
    path: `/${selectedYear.value}/${num}`,
    query: { category: String(categoryId) },
  });
}

function getResult(num, catId) {
  return summary.value.teams[num]?.results?.[catId] || "";
}

function getInspectors(num, catId) {
  const inspectors = summary.value.teams[num]?.inspectors?.[catId];
  return Array.isArray(inspectors) ? inspectors : [];
}

function getInspectorTitle(num, catId) {
  return getInspectors(num, catId).join(", ");
}

function isInspectorListCollapsed(num, catId) {
  return getInspectors(num, catId).length >= INSPECTOR_COLLAPSE_THRESHOLD;
}

// 카테고리 열은 여러 유형이 섞인 목록에서 공유되므로 열 자체는 남기고,
// 해당 유형에 표시하지 않는 카테고리는 그 팀의 칸만 완전히 비운다.
function appliesToTeam(cat, type) {
  if (!type) return true;
  return !(cat.excluded_types || []).includes(type);
}

// SSE로 카테고리 결과 실시간 반영
watch(lastUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete summary.value.teams[update.team_num];
    scheduleLifecycleRefresh();
    return;
  }
  if (update.renumbered) {
    if (summary.value.teams[update.prevNum]) {
      summary.value.teams[update.team_num] = summary.value.teams[update.prevNum];
      delete summary.value.teams[update.prevNum];
    }
    scheduleLifecycleRefresh();
    return;
  }
  const { team_num, category_id, result } = update;
  if (!summary.value.teams[team_num]) {
    summary.value.teams[team_num] = { inspectors: {}, results: {} };
  }
  summary.value.teams[team_num].results[category_id] = result;
});

// 응답·메모 편집으로 자동 갱신된 검차관 목록을 실시간 반영
watch(lastInspectorUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete summary.value.teams[update.team_num];
    scheduleLifecycleRefresh();
    return;
  }
  if (update.renumbered) {
    if (summary.value.teams[update.prevNum]) {
      summary.value.teams[update.team_num] = summary.value.teams[update.prevNum];
      delete summary.value.teams[update.prevNum];
    }
    scheduleLifecycleRefresh();
    return;
  }
  const { team_num, category_id, inspectors } = update;
  if (!summary.value.teams[team_num]) {
    summary.value.teams[team_num] = { inspectors: {}, results: {} };
  }
  summary.value.teams[team_num].inspectors[category_id] = Array.isArray(inspectors) ? inspectors : [];
});

watch(lastEntriesUpdate, (update) => {
  if (update?.year === selectedYear.value) scheduleLifecycleRefresh();
});
</script>

<template>
  <div class="sheet-list-page">
    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label">엔트리</label>
        <select
          v-model.number="selectedYear"
          class="filter-input"
          data-testid="inspection-team-year-filter"
          @change="onYearChange"
        >
          <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">검색</label>
        <input class="filter-input" v-model="searchQuery" placeholder="엔트리 / 학교 / 팀명" />
      </div>
      <div class="filter-group">
        <label class="filter-label">유형</label>
        <div class="type-filter-group" data-testid="inspection-team-type-filter">
          <label v-for="type in availableTypes" :key="type" class="filter-checkbox">
            <input v-model="typeFilters[type]" type="checkbox" :value="type" />
            <span class="badge" :class="'badge-type-' + getTypeColor(type)">{{ type }}</span>
          </label>
        </div>
      </div>
      <div v-if="isChief" class="filter-group template-action">
        <label class="filter-label">&nbsp;</label>
        <button class="btn btn-ghost" @click="router.push('/template')">템플릿 관리</button>
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <div class="card team-list-card">
      <div class="card-header">
        <div class="header-left">
          <h3>검차 시트</h3>
          <span class="count-badge">{{ filteredEntries.length }}개 팀</span>
        </div>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="sticky-host">
          <div
            class="page-sticky-header"
            data-testid="inspection-team-sticky-header"
            :style="stickyHeaderHostStyle"
            aria-hidden="true"
          >
            <div class="page-sticky-header-viewport">
              <div
                v-if="stickyHeaderMetrics.width"
                class="sticky-header-row"
                :style="stickyHeaderRowStyle"
              >
                <div class="sticky-header-cell col-num" :style="getStickyHeaderCellStyle(0)">엔트리</div>
                <div class="sticky-header-cell col-team" :style="getStickyHeaderCellStyle(1)">학교 / 팀</div>
                <div class="sticky-header-cell col-type" :style="getStickyHeaderCellStyle(2)">유형</div>
                <template v-for="(cat, index) in summary.categories" :key="'sticky-r'+cat.id">
                  <div class="sticky-header-cell col-result" :style="getStickyHeaderCellStyle(index + 3)">{{ cat.name }}</div>
                </template>
              </div>
            </div>
          </div>
          <div
            class="table-container"
            data-testid="inspection-team-table-scroll"
            @scroll="onTableScroll"
          >
          <table
            ref="tableRef"
            class="data-table sheet-table"
            :style="{ '--mobile-table-width': mobileTableWidth }"
          >
            <thead>
              <tr>
                <th class="col-num">엔트리</th>
                <th class="col-team">학교 / 팀</th>
                <th class="col-type">유형</th>
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
                <td class="col-num">
                  <div class="entry-summary">
                    <div class="entry-summary-top">
                      <span class="entry-num"><span class="mobile-entry-prefix">#</span>{{ entry.num }}</span>
                      <span
                        v-if="entry.type"
                        class="badge mobile-entry-type"
                        :class="'badge-type-' + getTypeColor(entry.type)"
                      >{{ entry.type }}</span>
                    </div>
                    <span class="mobile-entry-univ">{{ entry.univ }}</span>
                    <span class="mobile-entry-team">{{ entry.team }}</span>
                  </div>
                </td>
                <td class="col-team"><span class="entry-name">{{ entry.univ }} {{ entry.team }}</span></td>
                <td class="col-type">
                  <span v-if="entry.type" class="badge" :class="'badge-type-' + getTypeColor(entry.type)">{{ entry.type }}</span>
                </td>
                <template v-for="cat in summary.categories" :key="'r'+cat.id+'-'+entry.num">
                  <td
                    class="col-result"
                    :class="{ 'category-cell-link': appliesToTeam(cat, entry.type) }"
                    :data-category-id="cat.id"
                    :role="appliesToTeam(cat, entry.type) ? 'link' : undefined"
                    :tabindex="appliesToTeam(cat, entry.type) ? 0 : undefined"
                    @click.stop="appliesToTeam(cat, entry.type) && goToCategory(entry.num, cat.id)"
                    @keydown.enter.prevent.stop="appliesToTeam(cat, entry.type) && goToCategory(entry.num, cat.id)"
                    @keydown.space.prevent.stop="appliesToTeam(cat, entry.type) && goToCategory(entry.num, cat.id)"
                  >
                    <template v-if="appliesToTeam(cat, entry.type)">
                      <span
                        v-if="getResult(entry.num, cat.id)"
                        class="badge"
                        :class="getResult(entry.num, cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
                      >{{ getResult(entry.num, cat.id) }}</span>
                      <span v-else class="badge badge-empty">-</span>
                      <details
                        v-if="isInspectorListCollapsed(entry.num, cat.id)"
                        class="inspector-disclosure"
                        @click.stop
                      >
                        <summary
                          class="inspector-name"
                          :title="getInspectorTitle(entry.num, cat.id)"
                          :aria-label="`${cat.name} 검차관 ${getInspectors(entry.num, cat.id).length}명 전체 목록`"
                        >
                          <span class="inspector-preview">{{ getInspectors(entry.num, cat.id).slice(0, 2).join(", ") }}</span>
                          <span class="inspector-more">외 {{ getInspectors(entry.num, cat.id).length - 2 }}명</span>
                        </summary>
                        <div class="inspector-list" :aria-label="`${cat.name} 전체 검차관`">
                          <span v-for="name in getInspectors(entry.num, cat.id)" :key="name" class="inspector-person">{{ name }}</span>
                        </div>
                      </details>
                      <span
                        v-else-if="getInspectors(entry.num, cat.id).length"
                        class="inspector-name"
                        :title="getInspectorTitle(entry.num, cat.id)"
                      >({{ getInspectorTitle(entry.num, cat.id) }})</span>
                    </template>
                  </td>
                </template>
              </tr>
              <tr v-if="filteredEntries.length === 0">
                <td :colspan="3 + summary.categories.length" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
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

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.template-action {
  margin-left: auto;
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

.type-filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  min-height: 2.125rem;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.125rem;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-weight: 500;
  user-select: none;
  cursor: pointer;
}

.filter-checkbox input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent-primary);
  cursor: pointer;
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
  overflow: visible;
}

.table-container {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.sheet-table {
  min-width: 600px;
}

.sheet-table th {
  position: sticky;
  top: auto;
  z-index: 4;
  white-space: nowrap;
  font-size: 0.875rem;
  box-shadow: 0 1px 0 var(--border-color);
}

.col-num,
.col-team,
.col-type,
.col-result {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.sheet-table thead .col-num {
  z-index: 6;
}

.sticky-host {
  position: relative;
}

.team-list-card {
  overflow: visible;
}

.page-sticky-header {
  position: sticky;
  top: 0;
  z-index: 20;
  pointer-events: none;
}

.page-sticky-header-viewport {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.sticky-header-row {
  display: flex;
  height: 100%;
  background: var(--bg-secondary);
  will-change: transform;
}

.sticky-header-cell {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-weight: 600;
  white-space: nowrap;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  box-shadow: 0 1px 0 var(--border-color);
}

.sticky-header-cell[style*="translate3d"] {
  background: var(--bg-secondary);
}

.col-num,
.col-type,
.col-result {
  text-align: center !important;
}

.inspector-name {
  display: block;
  max-width: 10rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
  margin-top: 0.125rem;
  white-space: normal;
  overflow-wrap: anywhere;
}

.inspector-disclosure {
  max-width: 10rem;
  margin: 0.125rem auto 0;
  text-align: left;
}

.inspector-disclosure .inspector-name {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0;
  cursor: pointer;
  white-space: nowrap;
}

.inspector-disclosure .inspector-name::before {
  content: "▸";
  flex: none;
  color: var(--text-tertiary);
}

.inspector-disclosure[open] .inspector-name::before {
  content: "▾";
}

.inspector-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inspector-more {
  flex: none;
  color: var(--accent-primary);
  font-weight: 600;
}

.inspector-list {
  display: grid;
  gap: 0.125rem;
  margin-top: 0.25rem;
  padding-left: 0.75rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  white-space: normal;
  overflow-wrap: anywhere;
}

.inspector-person::before {
  content: "· ";
}

.entry-name {
  color: var(--text-primary);
  font-size: 0.875rem;
}

.mobile-entry-prefix,
.mobile-entry-type,
.mobile-entry-univ,
.mobile-entry-team {
  display: none;
}

.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}

.clickable-row:hover {
  background: var(--bg-hover);
}

.category-cell-link {
  cursor: pointer;
}

.category-cell-link:hover {
  background: var(--bg-hover);
}

.category-cell-link:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: -3px;
}

.badge-empty {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

@media (max-width: 640px) {
  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-input {
    width: 100%;
  }

  .template-action {
    margin-left: 0;
  }

  .template-action .btn {
    width: 100%;
  }

  .sheet-table {
    width: max(100%, var(--mobile-table-width));
    min-width: var(--mobile-table-width);
    table-layout: fixed;
  }

  .sheet-table th,
  .sheet-table td,
  .sticky-header-cell {
    padding: 0.625rem 0.5rem;
  }

  .sheet-table .col-team,
  .sheet-table .col-type,
  .sticky-header-cell.col-team,
  .sticky-header-cell.col-type {
    display: none;
  }

  .sheet-table .col-num,
  .sticky-header-cell.col-num {
    width: 148px;
    min-width: 148px;
    max-width: 148px;
    white-space: normal;
    text-align: left !important;
    justify-content: flex-start;
  }

  .sheet-table .col-result,
  .sticky-header-cell.col-result {
    width: 104px;
    min-width: 104px;
    max-width: 104px;
    padding-inline: 0.375rem;
    white-space: normal;
    justify-content: center;
  }

  .entry-summary,
  .entry-summary-top {
    min-width: 0;
  }

  .entry-summary {
    display: grid;
    gap: 0.125rem;
  }

  .entry-summary-top {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .mobile-entry-prefix,
  .mobile-entry-type,
  .mobile-entry-univ,
  .mobile-entry-team {
    display: inline;
  }

  .mobile-entry-prefix {
    color: var(--text-tertiary);
  }

  .mobile-entry-type {
    min-width: 0;
    padding: 0.125rem 0.375rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-entry-univ,
  .mobile-entry-team {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-entry-univ {
    color: var(--text-primary);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .mobile-entry-team {
    color: var(--text-tertiary);
    font-size: 0.75rem;
  }

  .inspector-name,
  .inspector-disclosure {
    max-width: 100%;
  }
}
</style>
