<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import {
  fetchEntries,
  fetchVehicleTypes,
  fetchSheetTemplate,
  fetchSheetData,
  updateSheetAnswer,
  updateSheetMemo,
  updateSheetCategoryResult,
} from "../api";
import { useNotification } from "@shared/useNotification.js";
import { useSSE } from "../composables/useSSE";
import { createSaveQueue, reconcileSaveQueuesAfterReconnect } from "../utils/save-queue";
import { createCalculationEvaluator, formatCalculationValue } from "../../../lib/calculations.mjs";
import { currentCompetitionYear } from "@shared/competition-year.mjs";

const { error } = useNotification();
const router = useRouter();
const route = useRoute();
const { lastUpdate, lastInspectorUpdate, lastAnswerUpdate, lastMemoUpdate, lastEntriesUpdate, reconnected } = useSSE();

const year = Number(route.params.year);
const num = Number(route.params.num);

const entry = ref(null);
const typeColorMap = ref({});
const template = ref([]);
const sheetData = ref({ answers: {}, results: {}, inspectors: {} });
const loading = ref(true);
const storedTab = Number(sessionStorage.getItem("inspectionActiveTab")) || 0;
const activeTab = ref(storedTab);
const tabsRef = ref(null);

watch(activeTab, (val) => {
  sessionStorage.setItem("inspectionActiveTab", val);
  scrollActiveTabIntoView();
});

function scrollActiveTabIntoView() {
  nextTick(() => {
    const tab = tabsRef.value?.children[activeTab.value];
    if (tab) tab.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  });
}

const isReadOnly = computed(() => year !== currentCompetitionYear());

// 이 팀의 차량 유형에 해당하는 카테고리만 남긴다. 유형이 없는 팀은 제외 대상이 없으므로 전체를 본다.
const visibleCategories = computed(() => {
  const type = entry.value?.type;
  if (!type) return template.value;
  return template.value.filter(cat => !(cat.excluded_types || []).includes(type));
});

const templateItemsById = computed(() => {
  const items = new Map();
  for (const cat of template.value) {
    for (const sub of cat.subcategories || []) {
      for (const group of sub.groups || []) {
        for (const item of group.items || []) items.set(Number(item.id), item);
      }
    }
  }
  return items;
});

const calculationResults = computed(() => {
  const items = Array.from(templateItemsById.value.values());
  const evaluator = createCalculationEvaluator(items, (itemId) => sheetData.value.answers[itemId]?.value ?? "");
  const results = new Map();
  for (const item of items) {
    if (item.calculation) results.set(item.id, evaluator.evaluate(item));
  }
  return results;
});

function getCalculationResult(item) {
  return calculationResults.value.get(item.id) || { status: "missing" };
}

function getCalculationText(item) {
  return formatCalculationValue(getCalculationResult(item));
}

function getCalculationHint(item) {
  const status = getCalculationResult(item).status;
  if (status === "missing" || status === "missing_source") return "원본 값 입력 후 계산됩니다.";
  if (status === "out_of_range") return "설정된 구간을 벗어났습니다.";
  if (status === "cycle") return "계산 설정에 순환 참조가 있습니다.";
  return status === "invalid" ? "원본 값이 올바른 숫자가 아닙니다." : "";
}

// 탭 번호는 템플릿 원본 순서를 따른다 — 유형별로 숨겨진 카테고리가 있어도
// 인쇄된 시트의 번호와 어긋나지 않게 한다.
const catNumById = computed(() =>
  Object.fromEntries(template.value.map((cat, idx) => [cat.id, catNum(idx)]))
);

const currentCategory = computed(() => visibleCategories.value[activeTab.value] || null);

onMounted(async () => {
  try {
    const [entries, tmpl, data, vtList] = await Promise.all([
      fetchEntries(year),
      fetchSheetTemplate(year),
      fetchSheetData(year, num),
      fetchVehicleTypes(year).catch(() => []),
    ]);
    entry.value = entries[num] || { univ: "?", team: "?" };
    template.value = tmpl;
    sheetData.value = data;
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
  const savedY = Number(sessionStorage.getItem("inspectionScrollY")) || 0;
  await nextTick();
  scrollActiveTabIntoView();
  requestAnimationFrame(() => window.scrollTo(0, savedY));
});

// 팀 목록과 동일한 유형 배지 색상 규칙 (등록되지 않은 유형은 blue로 폴백)
function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
}

function getAnswer(itemId) {
  return sheetData.value.answers[itemId]?.value ?? "";
}

function getMemo(itemId) {
  return sheetData.value.answers[itemId]?.memo ?? "";
}

function getAnswerUpdatedAt(itemId) {
  return sheetData.value.answers[itemId]?.answer_updated_at ?? null;
}

function getAnswerUpdatedBy(itemId) {
  return sheetData.value.answers[itemId]?.answer_updated_by ?? "";
}

function getMemoUpdatedAt(itemId) {
  return sheetData.value.answers[itemId]?.memo_updated_at ?? null;
}

function getMemoUpdatedBy(itemId) {
  return sheetData.value.answers[itemId]?.memo_updated_by ?? "";
}

function ensureAnswerRecord(itemId) {
  if (!sheetData.value.answers[itemId]) {
    sheetData.value.answers[itemId] = {
      value: "",
      memo: "",
      answer_updated_at: null,
      answer_updated_by: "",
      memo_updated_at: null,
      memo_updated_by: "",
    };
  }
  return sheetData.value.answers[itemId];
}

function getCategoryResult(catId) {
  return sheetData.value.results[catId] ?? "";
}

function getInspectors(catId) {
  const inspectors = sheetData.value.inspectors[catId];
  return Array.isArray(inspectors) ? inspectors : [];
}

const answerSaveStates = ref({});
const memoSaveStates = ref({});
const saveStateTimers = new Map();

function setSaveState(target, itemId, state, detail) {
  const timerKey = `${target === answerSaveStates ? "answer" : "memo"}-${itemId}`;
  clearTimeout(saveStateTimers.get(timerKey));
  target.value = { ...target.value, [itemId]: { state, detail } };
  if (state === "saved") {
    saveStateTimers.set(timerKey, setTimeout(() => {
      if (target.value[itemId]?.state === "saved") {
        target.value = { ...target.value, [itemId]: { state: "idle", detail: null } };
      }
      saveStateTimers.delete(timerKey);
    }, 1500));
  }
}

function updateAnswerMetadata(itemId, data) {
  const record = ensureAnswerRecord(itemId);
  record.answer_updated_at = data.updated_at ?? null;
  record.answer_updated_by = data.updated_by ?? "";
}

function updateMemoMetadata(itemId, data) {
  const record = ensureAnswerRecord(itemId);
  record.memo_updated_at = data.updated_at ?? null;
  record.memo_updated_by = data.updated_by ?? "";
}

const answerQueue = createSaveQueue({
  save: (itemId, request) => updateSheetAnswer({
    year,
    team_num: num,
    item_id: itemId,
    value: request.value,
    expectedValue: request.expected,
    mutation_id: request.mutationId,
  }),
  onState: (itemId, state, detail) => setSaveState(answerSaveStates, itemId, state, detail),
  onSaved: (itemId, response) => {
    updateAnswerMetadata(itemId, response);
  },
  responseValue: response => response.value,
  currentValue: current => current.value,
  onStale: (itemId, current) => {
    const record = ensureAnswerRecord(itemId);
    record.value = current.value;
    updateAnswerMetadata(itemId, current);
    error("다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.");
  },
  onError: () => error("응답 저장에 실패했습니다."),
});

const memoQueue = createSaveQueue({
  save: (itemId, request) => updateSheetMemo({
    year,
    team_num: num,
    item_id: itemId,
    memo: request.value,
    expectedMemo: request.expected,
    mutation_id: request.mutationId,
  }),
  onState: (itemId, state, detail) => setSaveState(memoSaveStates, itemId, state, detail),
  onSaved: (itemId, response) => {
    updateMemoMetadata(itemId, response);
  },
  responseValue: response => response.memo,
  currentValue: current => current.memo,
  onStale: (itemId, current) => {
    const record = ensureAnswerRecord(itemId);
    record.memo = current.memo;
    updateMemoMetadata(itemId, current);
    error("다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.");
  },
  onError: () => error("메모 저장에 실패했습니다."),
});

function onAnswerChange(itemId, value) {
  const expected = getAnswer(itemId);
  ensureAnswerRecord(itemId).value = value;
  answerQueue.enqueue(itemId, value, { expected });
}

function onPassFailToggle(itemId, val) {
  const current = getAnswer(itemId);
  const newVal = current === val ? "" : val;
  ensureAnswerRecord(itemId).value = newVal;
  answerQueue.enqueue(itemId, newVal, { expected: current, immediate: true });
}

function onCounterChange(itemId, delta) {
  if (isReadOnly.value) return;
  const expected = getAnswer(itemId);
  const newVal = nextCounterValue(expected, delta);
  ensureAnswerRecord(itemId).value = newVal;
  answerQueue.enqueue(itemId, newVal, { expected, immediate: true });
}

function onCounterInput(itemId, event) {
  const newVal = normalizeCounterInput(event.target.value);
  if (newVal === null) {
    event.target.value = getAnswer(itemId);
    return;
  }
  event.target.value = newVal;
  onAnswerChange(itemId, newVal);
}

function onMemoChange(itemId, memo) {
  const expected = getMemo(itemId);
  ensureAnswerRecord(itemId).memo = memo;
  memoQueue.enqueue(itemId, memo, { expected });
}

async function onCategoryResultToggle(catId, val) {
  const current = getCategoryResult(catId);
  const newVal = current === val ? "" : val;
  if (newVal === "PASS" && !inspectionStatusMap.value.complete) {
    error("모든 문항을 입력한 뒤 PASS할 수 있습니다.");
    return;
  }
  if (newVal === "PASS") await answerQueue.flushAll();
  sheetData.value.results[catId] = newVal;
  try {
    await updateSheetCategoryResult({ year, team_num: num, category_id: catId, result: newVal });
  } catch (e) {
    sheetData.value.results[catId] = current;
    error(e?.status === 409 ? "모든 문항을 입력한 뒤 PASS할 수 있습니다." : "저장에 실패했습니다.");
  }
}

// Click-to-edit memo
const editingMemo = ref(null);
const focusedItemId = ref(null);

function applyRemoteAnswer(update) {
  const record = ensureAnswerRecord(update.item_id);
  record.value = update.value;
  updateAnswerMetadata(update.item_id, update);
  answerQueue.acceptRemote(update.item_id, update.value);
}

function applyRemoteMemo(update) {
  const record = ensureAnswerRecord(update.item_id);
  record.memo = update.memo;
  updateMemoMetadata(update.item_id, update);
  memoQueue.acceptRemote(update.item_id, update.memo);
}

function handleAnswerBlur() {
  const prev = focusedItemId.value;
  focusedItemId.value = null;
  if (prev !== null) answerQueue.flush(prev);
}

function startEditMemo(itemId) {
  if (isReadOnly.value) return;
  editingMemo.value = itemId;
  nextTick(() => {
    const textarea = document.querySelector(`[data-memo-item="${itemId}"]`);
    if (!textarea) return;
    textarea.focus();
  });
}

function onMemoInput(itemId, event) {
  onMemoChange(itemId, event.target.value);
}

function finishEditMemo(itemId) {
  const memo = getMemo(itemId);
  const normalizedMemo = normalizeMemo(memo);
  if (normalizedMemo !== memo) onMemoChange(itemId, normalizedMemo);
  editingMemo.value = null;
  memoQueue.flush(itemId);
}

function retryAnswer(itemId) {
  answerQueue.retry(itemId);
}

function retryMemo(itemId) {
  memoQueue.retry(itemId);
}

// ---- Numbering ----
import {
  catNum,
  subNum,
  grpNum,
  itemNum,
  getChecktableConfig,
  nextCounterValue,
  normalizeCounterInput,
  normalizeMemo,
  formatStopwatchElapsed,
  buildInspectionStatusMap,
} from "../utils/sheet-helpers";

// 스톱워치는 검차 편의를 위한 로컬 도구이며 답변으로 저장하지 않는다.
const stopwatchStates = ref({});
const stopwatchNow = ref(Date.now());
let stopwatchInterval = null;

function getStopwatchState(itemId) {
  return stopwatchStates.value[itemId] || { elapsedMs: 0, startedAt: null };
}

function getStopwatchElapsed(itemId) {
  const state = getStopwatchState(itemId);
  return state.elapsedMs + (state.startedAt ? Math.max(0, stopwatchNow.value - state.startedAt) : 0);
}

function isStopwatchRunning(itemId) {
  return getStopwatchState(itemId).startedAt !== null;
}

function syncStopwatchInterval() {
  const hasRunningStopwatch = Object.values(stopwatchStates.value).some(state => state.startedAt !== null);
  if (hasRunningStopwatch && stopwatchInterval === null) {
    stopwatchInterval = window.setInterval(() => {
      stopwatchNow.value = Date.now();
    }, 10);
  } else if (!hasRunningStopwatch && stopwatchInterval !== null) {
    window.clearInterval(stopwatchInterval);
    stopwatchInterval = null;
  }
}

function toggleStopwatch(itemId) {
  if (isReadOnly.value) return;
  const now = Date.now();
  const state = getStopwatchState(itemId);
  stopwatchNow.value = now;
  stopwatchStates.value = {
    ...stopwatchStates.value,
    [itemId]: state.startedAt === null
      ? { elapsedMs: state.elapsedMs, startedAt: now }
      : { elapsedMs: state.elapsedMs + Math.max(0, now - state.startedAt), startedAt: null },
  };
  syncStopwatchInterval();
}

function resetStopwatch(itemId) {
  if (isReadOnly.value) return;
  stopwatchNow.value = Date.now();
  stopwatchStates.value = {
    ...stopwatchStates.value,
    [itemId]: { elapsedMs: 0, startedAt: null },
  };
  syncStopwatchInterval();
}

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

// ---- Item status map ----
const outlineOpen = ref(false);
const inspectionStatusMap = computed(() => buildInspectionStatusMap(
  currentCategory.value,
  sheetData.value.answers,
));

const statusLegend = computed(() => [
  { state: "pass", label: "PASS", count: inspectionStatusMap.value.counts.pass },
  { state: "fail", label: "FAIL", count: inspectionStatusMap.value.counts.fail },
  { state: "na", label: "N/A", count: inspectionStatusMap.value.counts.na },
  { state: "answered", label: "입력", count: inspectionStatusMap.value.counts.answered },
  { state: "unanswered", label: "미입력", count: inspectionStatusMap.value.counts.unanswered },
]);

function statusLabel(state) {
  return statusLegend.value.find(entry => entry.state === state)?.label || state;
}

function statusItemLabel(sub, group, item) {
  return `${sub.number}-${group.number} ${item.number} ${item.name}: ${statusLabel(item.state)}`;
}

function statusItems(state) {
  return inspectionStatusMap.value.subcategories.flatMap(sub =>
    sub.groups.flatMap(group => group.items
      .filter(item => item.state === state)
      .map(item => ({
        id: item.id,
        num: `${sub.number}-${group.number} ${item.number}`,
        name: item.name,
        sub: sub.name,
        group: group.name,
      }))),
  );
}

const failedOpen = ref(false);
const missingOpen = ref(false);
const failedItems = computed(() => statusItems("fail"));
const unansweredItems = computed(() => statusItems("unanswered"));

const memoOpen = ref(false);
const memoItems = computed(() => {
  const cat = currentCategory.value;
  if (!cat) return [];
  const items = [];
  for (const [si, sub] of (cat.subcategories || []).entries()) {
    for (const [gi, grp] of (sub.groups || []).entries()) {
      for (const [ii, item] of (grp.items || []).entries()) {
        const memo = normalizeMemo(getMemo(item.id));
        if (!memo) continue;
        items.push({
          id: item.id,
          path: `${subNum(si)}-${grpNum(gi)} ${itemNum(ii)} · ${sub.name} › ${grp.name}`,
          name: item.name,
          memo,
        });
      }
    }
  }
  return items;
});

const SUMMARY_COLLAPSE_MS = 220;
const SCROLL_TARGET_GAP = 8;

function waitForSummaryCollapse(shouldWait) {
  return shouldWait
    ? new Promise((resolve) => window.setTimeout(resolve, SUMMARY_COLLAPSE_MS))
    : Promise.resolve();
}

function scrollBelowProgress(element) {
  const progressHeight = document.querySelector(".inspection-progress")?.getBoundingClientRect().height || 0;
  const elementTop = window.scrollY + element.getBoundingClientRect().top;
  window.scrollTo({
    top: Math.max(0, elementTop - progressHeight - SCROLL_TARGET_GAP),
    behavior: "smooth",
  });
}

async function scrollToMemoItem(item) {
  const shouldWait = memoOpen.value;
  memoOpen.value = false;
  outlineOpen.value = false;
  await nextTick();
  await waitForSummaryCollapse(shouldWait);
  await scrollToItem(item.id);
}

function formatUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function scrollToItem(itemId) {
  outlineOpen.value = false;
  failedOpen.value = false;
  missingOpen.value = false;
  await nextTick();
  const el = document.getElementById(`item-${itemId}`);
  if (el) scrollBelowProgress(el);
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
  const expected = getAnswer(itemId);
  const val = getChecktableValue(itemId);
  const key = `${rowIdx}_${colIdx}`;
  if (val[key]) {
    delete val[key];
  } else {
    val[key] = "1";
  }
  const jsonStr = JSON.stringify(val);
  ensureAnswerRecord(itemId).value = jsonStr;
  answerQueue.enqueue(itemId, jsonStr, { expected, immediate: true });
}

// ---- Outline navigation ----
async function scrollToSub(subId) {
  outlineOpen.value = false;
  await nextTick();
  const el = document.getElementById(`sub-${subId}`);
  if (el) scrollBelowProgress(el);
}

async function scrollToGroup(groupId) {
  outlineOpen.value = false;
  await nextTick();
  const el = document.getElementById(`group-${groupId}`);
  if (el) scrollBelowProgress(el);
}

function scrollToTop() {
  outlineOpen.value = false;
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
  if (stopwatchInterval !== null) window.clearInterval(stopwatchInterval);
  for (const timer of saveStateTimers.values()) clearTimeout(timer);
  saveStateTimers.clear();
  answerQueue.flushAll();
  memoQueue.flushAll();
});

watch(activeTab, () => {
  outlineOpen.value = false;
  failedOpen.value = false;
  missingOpen.value = false;
  memoOpen.value = false;
  sessionStorage.setItem("inspectionScrollY", 0);
  window.scrollTo(0, 0);
});

watch(visibleCategories, (cats) => {
  if (cats && cats.length > 0 && activeTab.value >= cats.length) activeTab.value = 0;
}, { immediate: true });

// SSE로 카테고리 결과 실시간 반영 (같은 팀의 변경사항)
watch(lastUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (update.deleted) {
    router.replace("/");
    return;
  }
  if (update.renumbered) return;
  sheetData.value.results[update.category_id] = update.result;
});

// SSE로 검차관 실시간 반영
watch(lastInspectorUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (update.deleted) {
    router.replace("/");
    return;
  }
  if (update.renumbered) return;
  sheetData.value.inspectors[update.category_id] = Array.isArray(update.inspectors) ? update.inspectors : [];
});

// 다른 브라우저의 변경은 로컬 저장 대기열보다 우선한다. 편집 중이면
// 로컬 값을 버리고 새로고침 안내를 표시해 오래된 값이 저장되지 않게 한다.
watch(lastAnswerUpdate, (update) => {
  if (!update || update.year !== year) return;
  if (update.renumbered && update.prevNum === num) {
    router.replace("/");
    return;
  }
  if (update.team_num !== num) return;
  if (update.deleted) {
    router.replace("/");
    return;
  }
  if (answerQueue.isOwnMutation(update.item_id, update.mutation_id)) return;
  if (focusedItemId.value === update.item_id || answerQueue.isDirty(update.item_id)) {
    answerQueue.rejectForRemote(update.item_id, update);
    return;
  }
  applyRemoteAnswer(update);
});

// 메모도 답변과 같은 값 비교 규칙을 사용한다.
watch(lastMemoUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (update.deleted) {
    router.replace("/");
    return;
  }
  if (memoQueue.isOwnMutation(update.item_id, update.mutation_id)) return;
  if (editingMemo.value === update.item_id || memoQueue.isDirty(update.item_id)) {
    memoQueue.rejectForRemote(update.item_id, update);
    return;
  }
  applyRemoteMemo(update);
});

watch(lastEntriesUpdate, async (update) => {
  if (update?.year !== year) return;
  try {
    const [entries, vtList] = await Promise.all([
      fetchEntries(year),
      fetchVehicleTypes(year).catch(() => []),
    ]);
    if (!entries[num]) return router.replace("/");
    entry.value = entries[num];
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
  } catch (e) {
    error("팀 정보를 새로고침할 수 없습니다.");
  }
});

// 재연결 시 서버 상태를 다시 읽는다. 저장 중이던 값은 CAS 기준을 잃었으므로
// 보존하지 않고 사용자가 새로고침 후 다시 작성하도록 알린다.
watch(reconnected, async () => {
  if (!reconnected.value) return;
  try {
    const data = await fetchSheetData(year, num);
    reconcileSaveQueuesAfterReconnect({
      answers: data.answers,
      itemIds: templateItemsById.value.keys(),
      answerQueue,
      memoQueue,
    });
    sheetData.value = data;
  } catch {
    error("데이터 동기화에 실패했습니다.");
  }
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
          <!-- 유형 칩과 연도는 한 덩어리로 묶는다 — 팀명이 길어 줄이 넘어가도
               칩이 연도에서 떨어져 앞 줄에 남지 않게 한다. -->
          <span class="team-meta">
            <span
              v-if="entry?.type"
              class="badge team-type"
              :class="'badge-type-' + getTypeColor(entry.type)"
            >{{ entry.type }}</span>
            <span class="team-year">{{ year }}년</span>
          </span>
        </div>
      </div>

      <!-- Category Tabs -->
      <div class="tabs" ref="tabsRef" v-if="visibleCategories.length > 0">
        <button
          v-for="(cat, idx) in visibleCategories"
          :key="cat.id"
          class="tab"
          :class="{ active: activeTab === idx }"
          @click="activeTab = idx"
        >
          {{ catNumById[cat.id] }}. {{ cat.name }}
          <span
            v-if="getCategoryResult(cat.id)"
            class="tab-badge"
            :class="getCategoryResult(cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
          >{{ getCategoryResult(cat.id) }}</span>
        </button>
      </div>

      <!-- Current category status and navigation -->
      <section
        v-if="inspectionStatusMap.total"
        class="inspection-progress"
        aria-label="검차 문항 현황과 빠른 이동"
      >
        <div class="inspection-overview-header">
          <div
            class="inspection-progress-label"
            role="progressbar"
            :aria-valuenow="inspectionStatusMap.completed"
            aria-valuemin="0"
            :aria-valuemax="inspectionStatusMap.total"
            :aria-label="`검차 진행률 ${inspectionStatusMap.completed}/${inspectionStatusMap.total}`"
          >
            <strong>진행률</strong>
            <span>{{ inspectionStatusMap.completed }}/{{ inspectionStatusMap.total }} · {{ inspectionStatusMap.percent }}%</span>
          </div>
          <div class="inspection-overview-actions">
            <button
              type="button"
              class="inspection-outline-toggle"
              :aria-expanded="outlineOpen"
              @click="outlineOpen = !outlineOpen"
            >소분류 목차</button>
            <button type="button" class="inspection-top-button" @click="scrollToTop">맨 위로</button>
          </div>
        </div>

        <div class="inspection-status-legend" aria-label="문항 상태 범례">
          <span v-for="entry in statusLegend" :key="entry.state" class="status-legend-item">
            <span class="status-swatch" :class="`status-${entry.state}`"></span>
            {{ entry.label }} {{ entry.count }}
          </span>
        </div>

        <div class="inspection-status-map" aria-label="문항 상태 맵">
          <template v-for="sub in inspectionStatusMap.subcategories" :key="sub.id">
            <div
              v-for="group in sub.groups"
              v-show="group.items.length"
              :key="group.id"
              class="status-map-group"
              role="group"
              :aria-label="`${sub.number}-${group.number} ${sub.name}, ${group.name}`"
            >
              <button
                v-for="item in group.items"
                :key="item.id"
                type="button"
                class="status-map-item"
                :class="`status-${item.state}`"
                :aria-label="statusItemLabel(sub, group, item)"
                :title="statusItemLabel(sub, group, item)"
                @click="scrollToItem(item.id)"
              ></button>
            </div>
          </template>
        </div>

        <div v-if="outlineOpen" class="inspection-outline">
          <div class="inspection-outline-heading">소분류와 그룹을 눌러 이동</div>
          <div class="inspection-outline-list">
            <div
              v-for="(sub, si) in currentCategory.subcategories"
              :key="sub.id"
              class="inspection-outline-subcategory"
            >
              <button type="button" class="outline-subcategory-link" @click="scrollToSub(sub.id)">
                <span>{{ subNum(si) }}</span>
                <strong>{{ sub.name }}</strong>
              </button>
              <div class="inspection-outline-groups">
                <button
                  v-for="(group, gi) in sub.groups"
                  :key="group.id"
                  type="button"
                  @click="scrollToGroup(group.id)"
                >{{ subNum(si) }}-{{ grpNum(gi) }} {{ group.name }}</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Failed items are shown as soon as an item is marked FAIL. -->
      <div v-if="failedItems.length" class="status-summary failed-summary">
        <button
          type="button"
          class="status-summary-toggle failed-summary-toggle"
          :aria-expanded="failedOpen"
          @click="failedOpen = !failedOpen"
        >
          FAIL 항목 {{ failedItems.length }}개
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" :class="{ 'chevron-open': failedOpen }">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="failedOpen" class="status-summary-list failed-summary-list">
          <button
            v-for="item in failedItems"
            :key="item.id"
            type="button"
            class="status-summary-item failed-summary-item"
            @click="scrollToItem(item.id)"
          >
            <span class="memo-summary-path">{{ item.sub }} &rsaquo; {{ item.group }}</span>
            <span class="memo-summary-name"><span class="item-list-num">{{ item.num }}</span> {{ item.name }}</span>
          </button>
        </div>
      </div>

      <!-- Unanswered items are shown regardless of the category PASS/FAIL result. -->
      <div v-if="unansweredItems.length" class="status-summary missing-summary">
        <button
          type="button"
          class="status-summary-toggle missing-summary-toggle"
          :aria-expanded="missingOpen"
          @click="missingOpen = !missingOpen"
        >
          미입력 항목 {{ unansweredItems.length }}개
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" :class="{ 'chevron-open': missingOpen }">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="missingOpen" class="status-summary-list missing-summary-list">
          <button
            v-for="item in unansweredItems"
            :key="item.id"
            type="button"
            class="status-summary-item missing-summary-item"
            @click="scrollToItem(item.id)"
          >
            <span class="memo-summary-path">{{ item.sub }} &rsaquo; {{ item.group }}</span>
            <span class="memo-summary-name"><span class="item-list-num">{{ item.num }}</span> {{ item.name }}</span>
          </button>
        </div>
      </div>

      <!-- Memos in the current category -->
      <div v-if="memoItems.length" class="memo-summary">
        <button class="memo-summary-toggle" @click="memoOpen = !memoOpen">
          메모 {{ memoItems.length }}개
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" :class="{ 'chevron-open': memoOpen }">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <Transition name="memo-summary-list">
          <div v-if="memoOpen" class="memo-summary-list">
            <button v-for="item in memoItems" :key="item.id" class="memo-summary-item" @click="scrollToMemoItem(item)">
              <span class="memo-summary-path">{{ item.path }}</span>
              <span class="memo-summary-name">{{ item.name }}</span>
              <span class="memo-summary-preview">{{ item.memo }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <!-- Category Panel -->
      <div v-if="currentCategory" class="card category-panel">
        <div class="card-header panel-header">
          <div class="inspector-row">
            <span class="inspector-label">검차관</span>
            <div class="inspector-list" aria-live="polite">
              <span
                v-for="name in getInspectors(currentCategory.id)"
                :key="name"
                class="inspector-chip"
              >{{ name }}</span>
              <span v-if="!getInspectors(currentCategory.id).length" class="inspector-empty">
                응답 또는 메모를 편집하면 자동으로 추가됩니다.
              </span>
            </div>
          </div>
          <div class="result-toggle">
            <button
              class="btn btn-sm"
              :class="getCategoryResult(currentCategory.id) === 'PASS' ? 'btn-success' : 'btn-ghost'"
              :disabled="isReadOnly || (getCategoryResult(currentCategory.id) !== 'PASS' && !inspectionStatusMap.complete)"
              :title="inspectionStatusMap.complete || getCategoryResult(currentCategory.id) === 'PASS'
                ? '카테고리 PASS'
                : '진행률이 100%일 때 PASS할 수 있습니다.'"
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

            <div v-for="(grp, gi) in sub.groups" :key="grp.id" :id="`group-${grp.id}`" class="group-section">
              <h5 class="group-title">{{ grpNum(gi) }}. {{ grp.name }}<span v-if="grp.remarks" class="group-remarks"> — {{ grp.remarks }}</span></h5>

              <div v-for="(item, ii) in grp.items" :key="item.id" :id="`item-${item.id}`" class="item-row">
                <span class="item-num-label">{{ itemNum(ii) }}</span>
                <div class="item-content">
                  <div class="item-heading">
                    <div class="item-info">
                      <div class="item-name"><span v-html="renderMd(item.name)"></span></div>
                      <span v-if="item.remarks && item.answer_type !== 'checktable'" class="item-remarks">{{ item.remarks }}</span>
                    </div>
                  </div>
                  <div class="item-controls" :class="{ 'has-checktable': item.answer_type === 'checktable' }">
                  <!-- PASS/FAIL/N/A toggle -->
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
                    <button
                      class="btn btn-sm"
                      :class="getAnswer(item.id) === 'N/A' ? 'btn-na' : 'btn-ghost'"
                      :disabled="isReadOnly"
                      @click="onPassFailToggle(item.id, 'N/A')"
                    >N/A</button>
                  </div>
                  <!-- Number input -->
                  <div v-else-if="item.answer_type === 'number' && item.calculation?.mode === 'computed'" class="calculated-control">
                    <span class="calculated-label">자동 계산값</span>
                    <span v-if="getCalculationText(item)" class="calculated-value">{{ getCalculationText(item) }}</span>
                    <span v-else class="calculated-hint">{{ getCalculationHint(item) }}</span>
                    <span v-if="getCalculationText(item) && item.unit" class="unit-label">{{ item.unit }}</span>
                  </div>
                  <div v-else-if="item.answer_type === 'number' && item.calculation?.mode === 'suggestion'" class="suggestion-control">
                    <div class="suggested-value">
                      <span class="suggested-label">규정</span>
                      <strong v-if="getCalculationText(item)">{{ getCalculationText(item) }}<span v-if="item.unit"> {{ item.unit }}</span></strong>
                      <span v-else class="calculated-hint">{{ getCalculationHint(item) }}</span>
                    </div>
                    <label class="input-with-unit measured-value">
                      <span class="measured-label">실측값</span>
                      <input
                        type="number"
                        class="form-input inline-input number-input"
                        :value="getAnswer(item.id)"
                        @focus="focusedItemId = item.id"
                        @blur="handleAnswerBlur()"
                        @input="onAnswerChange(item.id, $event.target.value)"
                        :disabled="isReadOnly"
                        placeholder="값"
                      />
                      <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                    </label>
                  </div>
                  <div v-else-if="item.answer_type === 'number'" class="input-with-unit">
                    <input
                      type="number"
                      class="form-input inline-input number-input"
                      :value="getAnswer(item.id)"
                      @focus="focusedItemId = item.id"
                      @blur="handleAnswerBlur()"
                      @input="onAnswerChange(item.id, $event.target.value)"
                      :disabled="isReadOnly"
                      placeholder="값"
                    />
                    <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                  </div>
                  <!-- Counter input -->
                  <div v-else-if="item.answer_type === 'counter'" class="input-with-unit counter-control">
                    <button
                      type="button"
                      class="btn btn-danger btn-sm counter-button"
                      :disabled="isReadOnly || Number(getAnswer(item.id) || 0) <= 0"
                      :aria-label="`${item.name} 감소`"
                      @click="onCounterChange(item.id, -1)"
                    >−</button>
                    <input
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      class="form-input inline-input number-input counter-value"
                      :value="getAnswer(item.id)"
                      @focus="focusedItemId = item.id"
                      @blur="handleAnswerBlur()"
                      @input="onCounterInput(item.id, $event)"
                      :disabled="isReadOnly"
                      placeholder="0"
                      :aria-label="`${item.name} 현재 값`"
                    />
                    <button
                      type="button"
                      class="btn btn-success btn-sm counter-button"
                      :disabled="isReadOnly"
                      :aria-label="`${item.name} 증가`"
                      @click="onCounterChange(item.id, 1)"
                    >+</button>
                    <span v-if="item.unit" class="unit-label">{{ item.unit }}</span>
                  </div>
                  <!-- Text input -->
                  <div v-else-if="item.answer_type === 'text'" class="input-with-unit">
                    <input
                      type="text"
                      class="form-input inline-input text-input"
                      :value="getAnswer(item.id)"
                      @focus="focusedItemId = item.id"
                      @blur="handleAnswerBlur()"
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
                  </div>
                  <!-- Stopwatch: local convenience tool, no answer is saved. -->
                  <div v-else-if="item.answer_type === 'stopwatch'" class="stopwatch-control">
                    <span class="stopwatch-display">{{ formatStopwatchElapsed(getStopwatchElapsed(item.id)) }}</span>
                    <button
                      type="button"
                      class="btn btn-sm"
                      :class="isStopwatchRunning(item.id) ? 'btn-danger' : 'btn-success'"
                      :disabled="isReadOnly"
                      @click="toggleStopwatch(item.id)"
                    >{{ isStopwatchRunning(item.id) ? "정지" : "시작" }}</button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      :disabled="isReadOnly || getStopwatchElapsed(item.id) === 0"
                      @click="resetStopwatch(item.id)"
                    >초기화</button>
                  </div>
                  <div class="item-status-slot" aria-live="polite">
                    <div
                      v-if="['pending', 'saving', 'error'].includes(answerSaveStates[item.id]?.state)"
                      class="save-feedback"
                      :class="`save-${answerSaveStates[item.id].state}`"
                    >
                      <span v-if="answerSaveStates[item.id].state === 'pending' || answerSaveStates[item.id].state === 'saving'">응답 저장 중…</span>
                      <template v-else-if="answerSaveStates[item.id].state === 'error'">
                        <span>응답 저장 실패</span>
                        <button type="button" @click="retryAnswer(item.id)">재시도</button>
                      </template>
                    </div>

                    <div
                      v-if="['pending', 'saving', 'error'].includes(memoSaveStates[item.id]?.state)"
                      class="save-feedback"
                      :class="`save-${memoSaveStates[item.id].state}`"
                    >
                      <span v-if="memoSaveStates[item.id].state === 'pending' || memoSaveStates[item.id].state === 'saving'">메모 저장 중…</span>
                      <template v-else-if="memoSaveStates[item.id].state === 'error'">
                        <span>메모 저장 실패</span>
                        <button type="button" @click="retryMemo(item.id)">재시도</button>
                      </template>
                    </div>
                  </div>
                  <div
                    v-if="getAnswerUpdatedAt(item.id)"
                    class="edit-metadata answer-edit-metadata"
                    aria-live="polite"
                  >
                    {{ getAnswerUpdatedBy(item.id) || "알 수 없음" }} ·
                    <time :datetime="getAnswerUpdatedAt(item.id)">{{ formatUpdatedAt(getAnswerUpdatedAt(item.id)) }}</time>
                    <span v-if="answerSaveStates[item.id]?.state === 'saved'" class="save-saved"> · 응답 저장됨</span>
                  </div>
                  </div>

                  <!-- Memo: full content is visible below every answer control. -->
                  <div class="memo-area">
                    <div class="memo-editor">
                      <button
                        type="button"
                        class="memo-text"
                        :class="{
                          'memo-empty': !normalizeMemo(getMemo(item.id)),
                          'memo-readonly': isReadOnly,
                          'memo-editing': editingMemo === item.id,
                        }"
                        :disabled="isReadOnly"
                        @click="startEditMemo(item.id)"
                      >
                        <span class="memo-preview">{{ normalizeMemo(getMemo(item.id)) || "+ 메모 추가" }}</span>
                      </button>
                      <textarea
                        v-if="editingMemo === item.id"
                        class="form-input memo-input"
                        :value="getMemo(item.id)"
                        :data-memo-item="item.id"
                        rows="1"
                        @input="onMemoInput(item.id, $event)"
                        @blur="finishEditMemo(item.id)"
                        placeholder="메모 입력"
                      ></textarea>
                    </div>
                    <div
                      v-if="getMemoUpdatedAt(item.id)"
                      class="edit-metadata memo-edit-metadata"
                      aria-live="polite"
                    >
                      {{ getMemoUpdatedBy(item.id) || "알 수 없음" }} ·
                      <time :datetime="getMemoUpdatedAt(item.id)">{{ formatUpdatedAt(getMemoUpdatedAt(item.id)) }}</time>
                      <span v-if="memoSaveStates[item.id]?.state === 'saved'" class="save-saved"> · 메모 저장됨</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="template.length > 0" class="empty-state-box">
        <p>{{ entry?.type }} 유형에 표시할 검차 카테고리가 없습니다.</p>
        <button class="btn btn-ghost" @click="router.push('/template')">템플릿 관리</button>
      </div>

      <div v-else class="empty-state-box">
        <p>이 연도에 대한 검차 시트 템플릿이 없습니다.</p>
        <button class="btn btn-ghost" @click="router.push('/template')">템플릿 관리</button>
      </div>
    </template>

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

.team-meta {
  display: flex;
  align-items: center;
  gap: 1rem; /* .team-info의 gap과 맞춰 묶음 여부가 보이지 않게 한다 */
  flex-wrap: nowrap;
}

.team-type {
  flex-shrink: 0;
  white-space: nowrap;
}

.team-year {
  font-size: 0.875rem;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* Tabs */
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 10px;
  overflow-x: auto;
}

.tab {
  min-height: 44px;
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
  color: var(--text-primary);
  background: var(--bg-tab-active, var(--bg-card));
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
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
  flex-direction: column;
  align-items: stretch;
  gap: 0.625rem;
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

.inspector-list {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
  min-width: 0;
}

.inspector-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0.25rem 0.5rem;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-primary);
  font-size: 0.75rem;
  font-weight: 600;
}

.inspector-empty {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.4;
}

.result-toggle {
  display: flex;
  gap: 0.5rem;
}

.result-toggle button {
  flex: 1;
  min-height: 44px;
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

.item-heading {
  display: block;
  width: 100%;
  min-height: 1.5rem;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.item-status-slot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.375rem;
  min-width: 0;
  height: 2rem;
  overflow: hidden;
}

.item-controls.has-checktable {
  grid-template-columns: minmax(0, 1fr);
  gap: 0.25rem;
}

.item-controls.has-checktable .checktable-block,
.item-controls.has-checktable .item-status-slot {
  grid-column: 1;
}

.item-controls.has-checktable .item-status-slot {
  height: 1.25rem;
}

.edit-metadata {
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}

.answer-edit-metadata {
  grid-column: 1 / -1;
  width: 100%;
  text-align: left;
}

.pf-toggle {
  display: flex;
  gap: 0.5rem;
}

.pf-toggle button {
  min-width: 44px;
  min-height: 44px;
}

.pf-toggle .btn-na {
  background: #64748b;
  color: white;
}

.pf-toggle .btn-na:hover:not(:disabled) {
  background: #475569;
}

.inline-input {
  width: auto;
  min-height: 44px;
  padding: 0.375rem 0.625rem;
  font-size: 0.875rem;
}

.number-input {
  width: 80px;
  text-align: right;
}

.text-input {
  width: 180px;
  max-width: 100%;
}

.input-with-unit {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.calculated-control,
.suggestion-control,
.suggested-value,
.measured-value {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.calculated-control,
.suggestion-control {
  min-height: 44px;
}

.calculated-label,
.suggested-label,
.measured-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.calculated-value,
.suggested-value strong {
  font-family: "JetBrains Mono", monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.calculated-hint {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.suggested-value {
  padding: 0.375rem 0.625rem;
  min-height: 36px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.measured-value {
  margin-left: 0.25rem;
}

.counter-control {
  flex-wrap: wrap;
}

.counter-button {
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding-inline: 0;
  font-size: 1rem;
  line-height: 1;
}

.counter-value {
  width: 64px;
  height: 44px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.stopwatch-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}

.stopwatch-control button {
  min-height: 44px;
}

.stopwatch-display {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 9rem;
  min-height: 44px;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
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
  width: 100%;
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

/* Memo: full-width display and editor share the same content-driven height. */
.memo-area {
  width: 100%;
  min-width: 0;
}

.memo-editor {
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 44px;
}

.memo-text {
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: auto;
  min-height: 44px;
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.375rem 0.625rem;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.memo-text:hover {
  background: var(--bg-hover);
}

.memo-empty {
  color: var(--text-tertiary);
  font-style: italic;
  border-style: dashed;
  background: transparent;
}

.memo-readonly {
  cursor: default;
}

.memo-editing {
  visibility: hidden;
}

.memo-input {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 100%;
  resize: none;
  overflow-y: hidden;
  font-size: 0.875rem;
  line-height: 1.45;
  padding: 0.375rem 0.625rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.memo-preview {
  display: block;
  width: 100%;
  white-space: inherit;
}

.memo-edit-metadata {
  margin-top: 0.25rem;
  text-align: left;
}

.save-feedback {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: auto;
  height: 1.25rem;
  min-height: 0;
  font-size: 0.6875rem;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: visible;
}

.save-feedback button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent-primary);
  font: inherit;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.save-error {
  color: var(--accent-danger);
}

.save-saved {
  color: var(--accent-success);
}

.inspection-progress {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  position: sticky;
  top: 0;
  z-index: 20;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
}

.inspection-overview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem;
}

.inspection-progress-label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.inspection-progress-label strong {
  color: var(--text-primary);
  font-size: 0.75rem;
}

.inspection-overview-actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.inspection-outline-toggle,
.inspection-top-button {
  min-height: 32px;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.inspection-outline-toggle:hover,
.inspection-top-button:hover,
.inspection-outline-toggle[aria-expanded="true"] {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.inspection-status-legend {
  display: flex;
  flex-wrap: nowrap;
  gap: 0.5rem;
  min-width: 0;
  overflow-x: auto;
  color: var(--text-secondary);
  font-size: 0.6875rem;
  scrollbar-width: none;
}

.inspection-status-legend::-webkit-scrollbar {
  display: none;
}

.status-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
}

.status-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.inspection-status-map {
  display: grid;
  grid-template-columns: repeat(auto-fill, 12.5px);
  grid-auto-rows: 12.5px;
  gap: 2px;
  min-width: 0;
  padding-block: 0.125rem;
}

.status-map-group {
  display: contents;
}

.status-map-item {
  width: 12.5px;
  height: 12.5px;
  min-height: 12.5px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.status-map-item:hover {
  z-index: 1;
  transform: scale(1.25);
  box-shadow: var(--shadow-hover);
}

.status-map-item:focus-visible {
  z-index: 1;
  transform: scale(1.25);
}

.status-pass {
  background: var(--accent-success);
}

.status-fail {
  background: var(--accent-danger);
}

.status-na {
  background: #64748b;
}

.status-answered {
  background: var(--accent-primary);
}

.status-unanswered {
  border-color: var(--accent-warning);
  background: rgba(245, 158, 11, 0.12);
  color: var(--accent-warning);
}

.inspection-outline {
  max-height: 38vh;
  overflow-y: auto;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-color);
}

.inspection-outline-heading {
  margin-bottom: 0.5rem;
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  font-weight: 600;
}

.inspection-outline-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.5rem;
}

.inspection-outline-subcategory {
  min-width: 0;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.outline-subcategory-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 36px;
  padding: 0.25rem;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.outline-subcategory-link span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-primary);
  font-family: "JetBrains Mono", monospace;
}

.outline-subcategory-link strong {
  min-width: 0;
  overflow: hidden;
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspection-outline-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  padding: 0.25rem 0.25rem 0;
}

.inspection-outline-groups button {
  min-height: 36px;
  max-width: 100%;
  padding: 0.375rem 0.5rem;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.inspection-outline-groups button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* Team sheet memo index */
.memo-summary,
.status-summary {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-card);
  overflow: hidden;
}

.failed-summary {
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.08);
}

.missing-summary {
  border-color: rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.08);
}

.memo-summary-toggle,
.status-summary-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 44px;
  padding: 0.625rem 1rem;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.failed-summary-toggle,
.missing-summary-toggle {
  min-height: 36px;
  padding: 0.375rem 0.75rem;
}

.failed-summary-toggle {
  color: var(--accent-danger);
}

.missing-summary-toggle {
  color: var(--accent-warning);
}

.memo-summary-toggle svg,
.status-summary-toggle svg {
  transition: transform 0.2s;
}

.memo-summary-toggle .chevron-open,
.status-summary-toggle .chevron-open {
  transform: rotate(180deg);
}

.memo-summary-list,
.status-summary-list {
  max-height: 320px;
  overflow-y: auto;
  border-top: 1px solid var(--border-color);
}

.failed-summary-list {
  border-top-color: rgba(239, 68, 68, 0.25);
}

.missing-summary-list {
  border-top-color: rgba(245, 158, 11, 0.25);
}

.memo-summary-item,
.status-summary-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
  min-height: 44px;
  padding: 0.625rem 1rem;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.memo-summary-item + .memo-summary-item,
.status-summary-item + .status-summary-item {
  border-top: 1px solid var(--border-color);
}

.memo-summary-item:hover,
.status-summary-item:hover {
  background: var(--bg-hover);
}

.memo-summary-path {
  color: var(--text-tertiary);
  font-size: 0.6875rem;
}

.memo-summary-name {
  font-size: 0.8125rem;
  font-weight: 600;
}

.item-list-num {
  margin-right: 0.25rem;
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
}

.memo-summary-preview {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memo-summary-list-enter-active,
.memo-summary-list-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.memo-summary-list-enter-from,
.memo-summary-list-leave-to {
  max-height: 0;
  opacity: 0;
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

</style>
