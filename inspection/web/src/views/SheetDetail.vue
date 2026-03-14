<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import {
  fetchEntries,
  fetchSheetTemplate,
  fetchSheetData,
  updateSheetAnswer,
  updateSheetMemo,
  updateSheetCategoryResult,
  updateSheetInspector,
} from "../api";
import { useNotification } from "../composables/useNotification";
import { useSSE } from "../composables/useSSE";

const { error } = useNotification();
const router = useRouter();
const route = useRoute();
const { lastUpdate, lastInspectorUpdate, lastAnswerUpdate, lastMemoUpdate } = useSSE();

const year = Number(route.params.year);
const num = Number(route.params.num);

const entry = ref(null);
const template = ref([]);
const sheetData = ref({ answers: {}, results: {}, inspectors: {} });
const loading = ref(true);
const activeTab = ref(Number(sessionStorage.getItem("inspectionActiveTab")) || 0);

watch(activeTab, (val) => sessionStorage.setItem("inspectionActiveTab", val));

const isReadOnly = computed(() => year < new Date().getFullYear());

const currentCategory = computed(() => template.value[activeTab.value] || null);

onMounted(async () => {
  try {
    const [entries, tmpl, data] = await Promise.all([
      fetchEntries(year),
      fetchSheetTemplate(year),
      fetchSheetData(year, num),
    ]);
    entry.value = entries[num] || { univ: "?", team: "?" };
    template.value = tmpl;
    sheetData.value = data;
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
  const savedY = Number(sessionStorage.getItem("inspectionScrollY")) || 0;
  await nextTick();
  requestAnimationFrame(() => window.scrollTo(0, savedY));
});

function getAnswer(itemId) {
  return sheetData.value.answers[itemId]?.value ?? "";
}

function getMemo(itemId) {
  return sheetData.value.answers[itemId]?.memo ?? "";
}

function getCategoryResult(catId) {
  return sheetData.value.results[catId] ?? "";
}

function getInspector(catId) {
  return sheetData.value.inspectors[catId] ?? "";
}

// Debounce timers
const debounceTimers = {};

function debounce(key, fn, delay = 300) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(fn, delay);
}

async function onAnswerChange(itemId, value) {
  if (!sheetData.value.answers[itemId]) {
    sheetData.value.answers[itemId] = { value: "", memo: "" };
  }
  sheetData.value.answers[itemId].value = value;

  debounce(`answer-${itemId}`, async () => {
    try {
      await updateSheetAnswer({ year, team_num: num, item_id: itemId, value });
    } catch (e) {
      error("저장에 실패했습니다.");
    }
  });
}

function onPassFailToggle(itemId, val) {
  const current = getAnswer(itemId);
  const newVal = current === val ? "" : val;
  if (!sheetData.value.answers[itemId]) {
    sheetData.value.answers[itemId] = { value: "", memo: "" };
  }
  sheetData.value.answers[itemId].value = newVal;
  // passfail is immediate, no debounce
  updateSheetAnswer({ year, team_num: num, item_id: itemId, value: newVal }).catch(() => error("저장에 실패했습니다."));
}

async function onMemoChange(itemId, memo) {
  if (!sheetData.value.answers[itemId]) {
    sheetData.value.answers[itemId] = { value: "", memo: "" };
  }
  sheetData.value.answers[itemId].memo = memo;

  debounce(`memo-${itemId}`, async () => {
    try {
      await updateSheetMemo({ year, team_num: num, item_id: itemId, memo });
    } catch (e) {
      error("저장에 실패했습니다.");
    }
  });
}

async function onCategoryResultToggle(catId, val) {
  const current = getCategoryResult(catId);
  const newVal = current === val ? "" : val;
  if (newVal && !getInspector(catId)?.trim()) {
    error("검차관 이름을 입력하세요.");
    return;
  }
  sheetData.value.results[catId] = newVal;
  try {
    await updateSheetCategoryResult({ year, team_num: num, category_id: catId, result: newVal });
  } catch (e) {
    error("저장에 실패했습니다.");
  }
}

// 검차관 이름 자동완성 (localStorage)
const inspectorNames = ref(JSON.parse(localStorage.getItem("inspectorNames") || "[]"));

function saveInspectorName(name) {
  if (!name || name.length < 2) return;
  const names = new Set(inspectorNames.value);
  names.add(name);
  inspectorNames.value = [...names];
  localStorage.setItem("inspectorNames", JSON.stringify(inspectorNames.value));
}

async function onInspectorBlur(catId) {
  clearTimeout(debounceTimers[`inspector-${catId}`]);
  const inspector = getInspector(catId);
  saveInspectorName(inspector);
  try {
    await updateSheetInspector({ year, team_num: num, category_id: catId, inspector, broadcast: true });
  } catch (e) {
    error("저장에 실패했습니다.");
  }
}

async function onInspectorChange(catId, inspector) {
  sheetData.value.inspectors[catId] = inspector;
  debounce(`inspector-${catId}`, async () => {
    try {
      await updateSheetInspector({ year, team_num: num, category_id: catId, inspector });
    } catch (e) {
      error("저장에 실패했습니다.");
    }
  });
}

// Click-to-edit memo
const editingMemo = ref(null);

function startEditMemo(itemId) {
  if (isReadOnly.value) return;
  editingMemo.value = itemId;
}

function finishEditMemo(itemId) {
  editingMemo.value = null;
}

// ---- Numbering ----
import { catNum, subNum, grpNum, itemNum, getChecktableConfig } from "../utils/sheet-helpers";

// ---- Simple markdown rendering ----
function renderMd(text) {
  if (!text) return "";
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^[\*\-]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(bullet[1])}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (html) html += "<br>";
      html += inline(line);
    }
  }
  if (inList) html += "</ul>";
  return html;
}
function inline(t) {
  return t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// ---- Unanswered items ----
const missingOpen = ref(false);

const unansweredItems = computed(() => {
  const cat = currentCategory.value;
  if (!cat) return [];
  const result = getCategoryResult(cat.id);
  if (result !== "PASS") return [];
  const items = [];
  for (const sub of cat.subcategories || []) {
    for (const grp of sub.groups || []) {
      for (const item of grp.items || []) {
        if (item.answer_type === "checktable") {
          const config = getChecktableConfig(item);
          const val = getChecktableValue(item.id);
          for (let ri = 0; ri < config.rows.length; ri++) {
            for (let ci = 0; ci < config.columns.length; ci++) {
              if (!val[`${ri}_${ci}`]) {
                items.push({ id: item.id, name: `${config.rows[ri]} - ${config.columns[ci]}`, sub: sub.name, grp: grp.name });
              }
            }
          }
        } else if (!getAnswer(item.id)) {
          items.push({ id: item.id, name: item.name, sub: sub.name, grp: grp.name });
        }
      }
    }
  }
  return items;
});

// ---- Failed items ----
const failedOpen = ref(false);

const failedItems = computed(() => {
  const cat = currentCategory.value;
  if (!cat) return [];
  const items = [];
  for (const sub of cat.subcategories || []) {
    for (const grp of sub.groups || []) {
      for (const item of grp.items || []) {
        if (item.answer_type === "passfail" && getAnswer(item.id) === "FAIL") {
          items.push({ id: item.id, name: item.name, sub: sub.name, grp: grp.name });
        }
      }
    }
  }
  return items;
});

function scrollToItem(itemId) {
  missingOpen.value = false;
  failedOpen.value = false;
  const el = document.getElementById(`item-${itemId}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---- Checktable helpers ----
function getChecktableValue(itemId) {
  try {
    return JSON.parse(getAnswer(itemId)) || {};
  } catch {
    return {};
  }
}

function onChecktableToggle(itemId, rowIdx, colIdx) {
  const val = getChecktableValue(itemId);
  const key = `${rowIdx}_${colIdx}`;
  if (val[key]) {
    delete val[key];
  } else {
    val[key] = "1";
  }
  const jsonStr = JSON.stringify(val);
  if (!sheetData.value.answers[itemId]) {
    sheetData.value.answers[itemId] = { value: "", memo: "" };
  }
  sheetData.value.answers[itemId].value = jsonStr;
  updateSheetAnswer({ year, team_num: num, item_id: itemId, value: jsonStr }).catch(() => error("저장에 실패했습니다."));
}

// ---- Subcategory quick nav ----
const navOpen = ref(false);

function scrollToSub(subId) {
  navOpen.value = false;
  const el = document.getElementById(`sub-${subId}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToTop() {
  navOpen.value = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goBack() {
  router.push("/");
}

// ---- Scroll position persistence ----
let scrollTimer = null;
function onScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    sessionStorage.setItem("inspectionScrollY", window.scrollY);
  }, 200);
}

onMounted(() => {
  window.addEventListener("scroll", onScroll);
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  for (const timer of Object.values(debounceTimers)) {
    clearTimeout(timer);
  }
});

watch(activeTab, () => {
  sessionStorage.setItem("inspectionScrollY", 0);
  window.scrollTo(0, 0);
});

// SSE로 카테고리 결과 실시간 반영 (같은 팀의 변경사항)
watch(lastUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  sheetData.value.results[update.category_id] = update.result;
});

// SSE로 검차관 실시간 반영
watch(lastInspectorUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  sheetData.value.inspectors[update.category_id] = update.inspector;
});

// SSE로 개별 항목 답변 실시간 반영
watch(lastAnswerUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (!sheetData.value.answers[update.item_id]) {
    sheetData.value.answers[update.item_id] = { value: "", memo: "" };
  }
  sheetData.value.answers[update.item_id].value = update.value;
});

// SSE로 메모 실시간 반영
watch(lastMemoUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (!sheetData.value.answers[update.item_id]) {
    sheetData.value.answers[update.item_id] = { value: "", memo: "" };
  }
  sheetData.value.answers[update.item_id].memo = update.memo;
});
</script>

<template>
  <div class="sheet-detail-page">
    <div class="top-actions">
      <button class="btn btn-ghost back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="m15 18-6-6 6-6" />
        </svg>
        돌아가기
      </button>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>

    <template v-else>
      <!-- Team Header -->
      <div class="team-header card">
        <div class="card-body team-info">
          <span class="team-num">#{{ num }}</span>
          <span class="team-name">{{ entry?.univ }} {{ entry?.team }}</span>
          <span class="team-year">{{ year }}년</span>
        </div>
      </div>

      <!-- Category Tabs -->
      <div class="tabs" v-if="template.length > 0">
        <button
          v-for="(cat, idx) in template"
          :key="cat.id"
          class="tab"
          :class="{ active: activeTab === idx }"
          @click="activeTab = idx"
        >
          {{ catNum(idx) }}. {{ cat.name }}
          <span
            v-if="getCategoryResult(cat.id)"
            class="tab-badge"
            :class="getCategoryResult(cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
          >{{ getCategoryResult(cat.id) }}</span>
        </button>
      </div>

      <!-- Unanswered warning -->
      <div v-if="unansweredItems.length" class="missing-banner">
        <button class="missing-toggle" @click="missingOpen = !missingOpen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <circle cx="12" cy="17" r="0.5" fill="currentColor" />
          </svg>
          미입력 항목 {{ unansweredItems.length }}개
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" :class="{ 'chevron-open': missingOpen }">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <Transition name="missing-list">
          <div v-if="missingOpen" class="missing-list">
            <button v-for="item in unansweredItems" :key="item.id" class="missing-item" @click="scrollToItem(item.id)">
              <span class="missing-item-path">{{ item.sub }} &rsaquo; {{ item.grp }}</span>
              <span class="missing-item-name">{{ item.name }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <!-- Failed items warning -->
      <div v-if="failedItems.length" class="failed-banner">
        <button class="failed-toggle" @click="failedOpen = !failedOpen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          FAIL 항목 {{ failedItems.length }}개
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" :class="{ 'chevron-open': failedOpen }">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <Transition name="failed-list">
          <div v-if="failedOpen" class="failed-list">
            <button v-for="item in failedItems" :key="item.id" class="failed-item" @click="scrollToItem(item.id)">
              <span class="failed-item-path">{{ item.sub }} &rsaquo; {{ item.grp }}</span>
              <span class="failed-item-name">{{ item.name }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <!-- Category Panel -->
      <div v-if="currentCategory" class="card category-panel">
        <div class="card-header panel-header">
          <div class="inspector-row">
            <label class="inspector-label">검차관</label>
            <input
              class="form-input inspector-input"
              :value="getInspector(currentCategory.id)"
              @input="onInspectorChange(currentCategory.id, $event.target.value)"
              @blur="onInspectorBlur(currentCategory.id)"
              :disabled="isReadOnly"
              placeholder="이름"
              list="inspector-names"
            />
            <datalist id="inspector-names">
              <option v-for="name in inspectorNames" :key="name" :value="name" />
            </datalist>
          </div>
          <div class="result-toggle">
            <button
              class="btn btn-sm"
              :class="getCategoryResult(currentCategory.id) === 'PASS' ? 'btn-success' : 'btn-ghost'"
              :disabled="isReadOnly"
              @click="onCategoryResultToggle(currentCategory.id, 'PASS')"
            >PASS</button>
            <button
              class="btn btn-sm"
              :class="getCategoryResult(currentCategory.id) === 'FAIL' ? 'btn-danger' : 'btn-ghost'"
              :disabled="isReadOnly"
              @click="onCategoryResultToggle(currentCategory.id, 'FAIL')"
            >FAIL</button>
          </div>
        </div>

        <div class="card-body panel-body">
          <div v-if="!currentCategory.subcategories?.length" class="empty-state">템플릿 항목이 없습니다.</div>

          <div v-for="(sub, si) in currentCategory.subcategories" :key="sub.id" :id="`sub-${sub.id}`" class="subcategory-section">
            <h4 class="subcategory-title">{{ subNum(si) }} - {{ sub.name }}<span v-if="sub.remarks" class="subcategory-remarks"> — {{ sub.remarks }}</span></h4>

            <div v-for="(grp, gi) in sub.groups" :key="grp.id" class="group-section">
              <h5 class="group-title">{{ grpNum(gi) }}. {{ grp.name }}<span v-if="grp.remarks" class="group-remarks"> — {{ grp.remarks }}</span></h5>

              <div v-for="(item, ii) in grp.items" :key="item.id" :id="`item-${item.id}`" class="item-row">
                <span class="item-num-label">{{ itemNum(ii) }}</span>
                <div class="item-content">
                  <div class="item-info">
                    <div class="item-name"><span v-html="renderMd(item.name)"></span></div>
                    <span v-if="item.remarks && item.answer_type !== 'checktable'" class="item-remarks">{{ item.remarks }}</span>
                  </div>
                  <div class="item-controls">
                  <!-- PASS/FAIL toggle -->
                  <div v-if="item.answer_type === 'passfail'" class="pf-toggle">
                    <button
                      class="btn btn-sm"
                      :class="getAnswer(item.id) === 'PASS' ? 'btn-success' : 'btn-ghost'"
                      :disabled="isReadOnly"
                      @click="onPassFailToggle(item.id, 'PASS')"
                    >P</button>
                    <button
                      class="btn btn-sm"
                      :class="getAnswer(item.id) === 'FAIL' ? 'btn-danger' : 'btn-ghost'"
                      :disabled="isReadOnly"
                      @click="onPassFailToggle(item.id, 'FAIL')"
                    >F</button>
                  </div>
                  <!-- Number input -->
                  <div v-else-if="item.answer_type === 'number'" class="input-with-unit">
                    <input
                      type="number"
                      class="form-input inline-input number-input"
                      :value="getAnswer(item.id)"
                      @input="onAnswerChange(item.id, $event.target.value)"
                      :disabled="isReadOnly"
                      placeholder="값"
                    />
                    <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                  </div>
                  <!-- Text input -->
                  <div v-else-if="item.answer_type === 'text'" class="input-with-unit">
                    <input
                      type="text"
                      class="form-input inline-input text-input"
                      :value="getAnswer(item.id)"
                      @input="onAnswerChange(item.id, $event.target.value)"
                      :disabled="isReadOnly"
                      placeholder="입력"
                    />
                    <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                  </div>
                  <!-- Checktable -->
                  <div v-else-if="item.answer_type === 'checktable'" class="checktable-block">
                    <div class="checktable-wrapper">
                      <table class="checktable">
                        <thead>
                          <tr>
                            <th></th>
                            <th v-for="col in getChecktableConfig(item).columns" :key="col">{{ col }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(row, ri) in getChecktableConfig(item).rows" :key="row">
                            <td class="checktable-row-header">{{ row }}</td>
                            <td v-for="(col, ci) in getChecktableConfig(item).columns" :key="col" class="checktable-cell">
                              <input
                                type="checkbox"
                                :checked="!!getChecktableValue(item.id)[`${ri}_${ci}`]"
                                @change="onChecktableToggle(item.id, ri, ci)"
                                :disabled="isReadOnly"
                              />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <!-- Memo (checktable: 테이블 아래, 스크롤 영역 밖) -->
                    <input
                      v-if="editingMemo === item.id"
                      class="form-input memo-input"
                      :value="getMemo(item.id)"
                      @input="onMemoChange(item.id, $event.target.value)"
                      @blur="finishEditMemo(item.id)"
                      @keydown.enter="finishEditMemo(item.id)"
                      placeholder="메모 입력"
                      autofocus
                    />
                    <span
                      v-else
                      class="memo-text"
                      :class="{ 'memo-empty': !getMemo(item.id) }"
                      @click="startEditMemo(item.id)"
                    >{{ getMemo(item.id) || "메모" }}</span>
                  </div>
                  <!-- Memo (기본: controls 행 내) -->
                  <template v-if="item.answer_type !== 'checktable'">
                  <input
                    v-if="editingMemo === item.id"
                    class="form-input memo-input"
                    :value="getMemo(item.id)"
                    @input="onMemoChange(item.id, $event.target.value)"
                    @blur="finishEditMemo(item.id)"
                    @keydown.enter="finishEditMemo(item.id)"
                    placeholder="메모 입력"
                    autofocus
                  />
                  <span
                    v-else
                    class="memo-text"
                    :class="{ 'memo-empty': !getMemo(item.id) }"
                    @click="startEditMemo(item.id)"
                  >{{ getMemo(item.id) || "메모" }}</span>
                  </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty-state-box">
        <p>이 연도에 대한 검차 시트 템플릿이 없습니다.</p>
        <button class="btn btn-ghost" @click="router.push('/template')">템플릿 관리</button>
      </div>
    </template>

    <!-- Quick nav FAB -->
    <div v-if="currentCategory?.subcategories?.length" class="fab-container">
      <Transition name="nav-menu">
        <div v-if="navOpen" class="nav-menu">
          <button class="nav-menu-item nav-menu-top" @click="scrollToTop">맨 위로</button>
          <button
            v-for="(sub, si) in currentCategory.subcategories"
            :key="sub.id"
            class="nav-menu-item"
            @click="scrollToSub(sub.id)"
          >{{ subNum(si) }} - {{ sub.name }}</button>
        </div>
      </Transition>
      <button class="fab" @click="navOpen = !navOpen" :class="{ active: navOpen }">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sheet-detail-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.top-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

.team-info {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.team-num {
  font-size: 1.5rem;
  font-weight: 800;
  font-family: "JetBrains Mono", monospace;
  color: var(--accent-primary);
}

.team-name {
  font-size: 1.125rem;
  font-weight: 600;
}

.team-year {
  font-size: 0.875rem;
  color: var(--text-tertiary);
}

/* Tabs */
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  background: var(--bg-secondary);
  border-radius: 10px;
  overflow-x: auto;
  border: 1px solid var(--border-color);
}

.tab {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  border: none;
  background: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab.active {
  color: var(--accent-primary);
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
}

.tab-badge {
  font-size: 0.625rem;
  font-weight: 700;
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
}

.tab-badge.badge-success {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}

.tab-badge.badge-danger {
  background: rgba(239, 68, 68, 0.15);
  color: var(--accent-danger);
}

/* Panel */
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.inspector-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inspector-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}

.inspector-input {
  width: 120px;
  min-width: 80px;
}

.result-toggle {
  display: flex;
  gap: 0.375rem;
}

.panel-body {
  padding: 1rem 1.25rem !important;
}

/* Subcategory & Group */
.subcategory-section {
  margin-bottom: 1.5rem;
}

.subcategory-section:last-child {
  margin-bottom: 0;
}

.subcategory-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.75rem;
  padding-bottom: 0.375rem;
  border-bottom: 2px solid var(--accent-primary);
  word-break: keep-all;
  overflow-wrap: break-word;
}

.subcategory-remarks {
  font-weight: 400;
  font-size: 0.8125rem;
  color: var(--text-tertiary);
}

.group-section {
  margin-bottom: 1rem;
}

.group-title {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
  margin-top: 0.75rem;
  word-break: keep-all;
  overflow-wrap: break-word;
}

.group-remarks {
  font-weight: 400;
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

/* Item row */
.item-row {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding: 0.625rem 0 0.625rem 0.5rem;
}

.item-num-label {
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
  flex-shrink: 0;
  font-size: 0.875rem;
}

.item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.item-info {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
  flex: 1;
}

.item-name {
  font-size: 0.875rem;
  font-weight: 500;
  word-break: keep-all;
  overflow-wrap: break-word;
}

.item-name :deep(ul) {
  margin: 0.25rem 0;
  padding-left: 1.5em;
}

.item-name :deep(li) {
  margin: 0;
}

.item-remarks {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.item-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.pf-toggle {
  display: flex;
  gap: 0.25rem;
}

.inline-input {
  width: auto;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
}

.number-input {
  width: 80px;
  text-align: right;
}

.text-input {
  width: 120px;
}

.input-with-unit {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.unit-label {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* Checktable */
.checktable-block {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.checktable-wrapper {
  overflow-x: auto;
}

.checktable {
  border-collapse: collapse;
  font-size: 0.8125rem;
  width: auto;
}

.checktable th,
.checktable td {
  border: 1px solid var(--border-color);
  padding: 0.375rem 0.625rem;
  text-align: center;
  white-space: nowrap;
}

.checktable th {
  background: var(--bg-secondary);
  font-weight: 600;
  font-size: 0.75rem;
}

.checktable .checktable-row-header {
  font-weight: 600;
  text-align: left;
  background: var(--bg-secondary);
  font-size: 0.75rem;
}

.checktable .checktable-cell input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent-primary);
  cursor: pointer;
}

.checktable .checktable-cell input:disabled {
  cursor: default;
}

/* Memo inline */
.memo-text {
  font-size: 0.75rem;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  white-space: nowrap;
}

.memo-text:hover {
  background: var(--bg-hover);
}

.memo-empty {
  color: var(--text-tertiary);
  font-style: italic;
}

.memo-input {
  flex: 1;
  width: auto;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
}

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

.empty-state-box {
  text-align: center;
  padding: 3rem;
  color: var(--text-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
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

/* Missing items banner */
.missing-banner {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 10px;
  overflow: hidden;
}

.missing-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 1rem;
  border: none;
  background: none;
  color: var(--accent-warning);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.missing-toggle:hover {
  background: rgba(245, 158, 11, 0.08);
}

.missing-toggle .chevron-open {
  transform: rotate(180deg);
}

.missing-toggle svg:last-child {
  margin-left: auto;
  transition: transform 0.2s;
}

.missing-list {
  border-top: 1px solid rgba(245, 158, 11, 0.2);
  max-height: 300px;
  overflow-y: auto;
}

.missing-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.missing-item:hover {
  background: rgba(245, 158, 11, 0.08);
}

.missing-item + .missing-item {
  border-top: 1px solid rgba(245, 158, 11, 0.1);
}

.missing-item-path {
  font-size: 0.6875rem;
  color: var(--text-tertiary);
}

.missing-item-name {
  font-size: 0.8125rem;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.missing-list-enter-active,
.missing-list-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.missing-list-enter-from,
.missing-list-leave-to {
  max-height: 0;
  opacity: 0;
}

/* Failed items banner */
.failed-banner {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 10px;
  overflow: hidden;
}

.failed-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 1rem;
  border: none;
  background: none;
  color: var(--accent-danger);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.failed-toggle:hover {
  background: rgba(239, 68, 68, 0.08);
}

.failed-toggle .chevron-open {
  transform: rotate(180deg);
}

.failed-toggle svg:last-child {
  margin-left: auto;
  transition: transform 0.2s;
}

.failed-list {
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  max-height: 300px;
  overflow-y: auto;
}

.failed-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.failed-item:hover {
  background: rgba(239, 68, 68, 0.08);
}

.failed-item + .failed-item {
  border-top: 1px solid rgba(239, 68, 68, 0.1);
}

.failed-item-path {
  font-size: 0.6875rem;
  color: var(--text-tertiary);
}

.failed-item-name {
  font-size: 0.8125rem;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.failed-list-enter-active,
.failed-list-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.failed-list-enter-from,
.failed-list-leave-to {
  max-height: 0;
  opacity: 0;
}

/* Quick nav FAB */
.fab-container {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
  z-index: 100;
}

.fab {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: var(--accent-primary);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  transition: transform 0.2s, background 0.2s;
}

.fab:hover {
  background: var(--accent-primary-hover, #4f46e5);
}

.fab.active {
  transform: rotate(90deg);
}

.nav-menu {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  max-height: 60vh;
  overflow-y: auto;
  min-width: 180px;
}

.nav-menu-item {
  display: block;
  width: 100%;
  padding: 0.625rem 1rem;
  border: none;
  background: none;
  text-align: left;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.nav-menu-item:hover {
  background: var(--bg-hover);
}

.nav-menu-top {
  color: var(--accent-primary);
  font-weight: 600;
}

.nav-menu-item + .nav-menu-item {
  border-top: 1px solid var(--border-color);
}

.nav-menu-enter-active,
.nav-menu-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}

.nav-menu-enter-from,
.nav-menu-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 640px) {
  .inspector-input {
    width: 100px;
  }
}
</style>
