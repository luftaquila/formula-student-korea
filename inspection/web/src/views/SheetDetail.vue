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
  updateSheetInspector,
} from "../api";
import { useNotification } from "@shared/useNotification.js";
import { user } from "@shared/officialsStore.js";
import { createKeyedDebouncer } from "@shared/debounce.js";
import { useSSE } from "../composables/useSSE";
import { createVersionedSaveQueue } from "../utils/versioned-save-queue";
import { createCalculationEvaluator, formatCalculationValue } from "../../../lib/calculations.mjs";

const { error } = useNotification();
const router = useRouter();
const route = useRoute();
const { lastUpdate, lastInspectorUpdate, lastAnswerUpdate, lastMemoUpdate, reconnected } = useSSE();

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
const draftStorageKey = `inspection-sheet-drafts-${year}-${num}`;
let localDrafts = { answers: {}, memos: {} };

try {
  const storedDrafts = JSON.parse(localStorage.getItem(draftStorageKey) || "null");
  if (storedDrafts && typeof storedDrafts === "object") {
    localDrafts = {
      answers: storedDrafts.answers || {},
      memos: storedDrafts.memos || {},
    };
  }
} catch {
  try { localStorage.removeItem(draftStorageKey); } catch {}
}

function persistDrafts() {
  try {
    if (!Object.keys(localDrafts.answers).length && !Object.keys(localDrafts.memos).length) {
      localStorage.removeItem(draftStorageKey);
      return;
    }
    localStorage.setItem(draftStorageKey, JSON.stringify(localDrafts));
  } catch {
    // 자동 저장 자체는 계속 동작한다. 저장소 용량/보안 설정으로 초안 보관만 실패할 수 있다.
  }
}

function setDraft(kind, itemId, value, baseVersion) {
  localDrafts[kind][itemId] = { value, baseVersion };
  persistDrafts();
}

function clearDraft(kind, itemId) {
  delete localDrafts[kind][itemId];
  persistDrafts();
}

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

const isReadOnly = computed(() => year < new Date().getFullYear());

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
    restoreLocalDrafts();
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
      answer_version: 0,
      answer_updated_at: null,
      answer_updated_by: "",
      memo_version: 0,
      memo_updated_at: null,
      memo_updated_by: "",
    };
  }
  return sheetData.value.answers[itemId];
}

function getCategoryResult(catId) {
  return sheetData.value.results[catId] ?? "";
}

function getInspector(catId) {
  return sheetData.value.inspectors[catId] ?? "";
}

// 검차관 이름은 기존 키 단위 디바운스를 유지한다.
const { debounce, cancel: cancelDebounce, flush: flushDebounce } = createKeyedDebouncer(300);

const answerSaveStates = ref({});
const memoSaveStates = ref({});
const answerConflicts = ref({});
const memoConflicts = ref({});
const deferredAnswerUpdates = new Map();
const deferredMemoUpdates = new Map();
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

function clearConflict(target, itemId) {
  if (!target.value[itemId]) return;
  const next = { ...target.value };
  delete next[itemId];
  target.value = next;
}

function updateAnswerMetadata(itemId, data) {
  const record = ensureAnswerRecord(itemId);
  if (data.version !== undefined && data.version !== null) record.answer_version = Number(data.version) || 0;
  record.answer_updated_at = data.updated_at ?? null;
  record.answer_updated_by = data.updated_by ?? "";
}

function updateMemoMetadata(itemId, data) {
  const record = ensureAnswerRecord(itemId);
  if (data.version !== undefined && data.version !== null) record.memo_version = Number(data.version) || 0;
  record.memo_updated_at = data.updated_at ?? null;
  record.memo_updated_by = data.updated_by ?? "";
}

const answerQueue = createVersionedSaveQueue({
  getVersion: itemId => ensureAnswerRecord(itemId).answer_version,
  save: (itemId, request) => updateSheetAnswer({
    year,
    team_num: num,
    item_id: itemId,
    value: request.value,
    base_version: request.baseVersion,
    mutation_id: request.mutationId,
  }),
  onState: (itemId, state, detail) => setSaveState(answerSaveStates, itemId, state, detail),
  onSaved: (itemId, response) => {
    updateAnswerMetadata(itemId, response);
    if (getAnswer(itemId) === response.value) clearDraft("answers", itemId);
    clearConflict(answerConflicts, itemId);
    queueMicrotask(() => applyDeferredAnswer(itemId));
  },
  onConflict: (itemId, current, localValue) => {
    answerConflicts.value = { ...answerConflicts.value, [itemId]: { current, localValue } };
  },
  onError: () => error("응답 저장에 실패했습니다."),
});

const memoQueue = createVersionedSaveQueue({
  getVersion: itemId => ensureAnswerRecord(itemId).memo_version,
  save: (itemId, request) => updateSheetMemo({
    year,
    team_num: num,
    item_id: itemId,
    memo: request.value,
    base_version: request.baseVersion,
    mutation_id: request.mutationId,
  }),
  onState: (itemId, state, detail) => setSaveState(memoSaveStates, itemId, state, detail),
  onSaved: (itemId, response) => {
    updateMemoMetadata(itemId, response);
    if (getMemo(itemId) === response.memo) clearDraft("memos", itemId);
    clearConflict(memoConflicts, itemId);
    queueMicrotask(() => applyDeferredMemo(itemId));
  },
  onConflict: (itemId, current, localValue) => {
    memoConflicts.value = { ...memoConflicts.value, [itemId]: { current, localValue } };
  },
  onError: () => error("메모 저장에 실패했습니다."),
});

function onAnswerChange(itemId, value) {
  ensureAnswerRecord(itemId).value = value;
  editedDuringFocus.add(itemId);
  clearConflict(answerConflicts, itemId);
  setDraft("answers", itemId, value, answerQueue.currentVersion(itemId));
  answerQueue.enqueue(itemId, value);
}

function onPassFailToggle(itemId, val) {
  const current = getAnswer(itemId);
  const newVal = current === val ? "" : val;
  ensureAnswerRecord(itemId).value = newVal;
  clearConflict(answerConflicts, itemId);
  setDraft("answers", itemId, newVal, answerQueue.currentVersion(itemId));
  answerQueue.enqueue(itemId, newVal, { immediate: true });
}

function onCounterChange(itemId, delta) {
  if (isReadOnly.value) return;
  const newVal = nextCounterValue(getAnswer(itemId), delta);
  ensureAnswerRecord(itemId).value = newVal;
  clearConflict(answerConflicts, itemId);
  setDraft("answers", itemId, newVal, answerQueue.currentVersion(itemId));
  answerQueue.enqueue(itemId, newVal, { immediate: true });
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
  ensureAnswerRecord(itemId).memo = memo;
  editedMemos.add(itemId);
  clearConflict(memoConflicts, itemId);
  setDraft("memos", itemId, memo, memoQueue.currentVersion(itemId));
  memoQueue.enqueue(itemId, memo);
}

function restoreLocalDrafts() {
  if (isReadOnly.value) return;
  for (const [rawItemId, draft] of Object.entries(localDrafts.answers)) {
    const itemId = Number(rawItemId);
    const draftValue = normalizeRestorableAnswerDraft(templateItemsById.value.get(itemId), draft.value);
    if (draftValue === null) {
      clearDraft("answers", itemId);
      continue;
    }
    const record = ensureAnswerRecord(itemId);
    const serverValue = record.value;
    if (record.value === draftValue) {
      clearDraft("answers", itemId);
      continue;
    }
    record.value = draftValue;
    answerQueue.enqueue(itemId, draftValue);
    if ((draft.baseVersion ?? 0) !== (record.answer_version ?? 0)) {
      answerQueue.markConflict(itemId, {
        value: serverValue,
        version: record.answer_version ?? 0,
        updated_at: record.answer_updated_at,
        updated_by: record.answer_updated_by,
      });
    }
  }
  for (const [rawItemId, draft] of Object.entries(localDrafts.memos)) {
    const itemId = Number(rawItemId);
    const record = ensureAnswerRecord(itemId);
    const serverMemo = record.memo;
    if (record.memo === draft.value) {
      clearDraft("memos", itemId);
      continue;
    }
    record.memo = draft.value;
    memoQueue.enqueue(itemId, draft.value);
    if ((draft.baseVersion ?? 0) !== (record.memo_version ?? 0)) {
      memoQueue.markConflict(itemId, {
        memo: serverMemo,
        version: record.memo_version ?? 0,
        updated_at: record.memo_updated_at,
        updated_by: record.memo_updated_by,
      });
    }
  }
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

async function onInspectorBlur(catId) {
  cancelDebounce(`inspector-${catId}`);
  const inspector = getInspector(catId);
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

// 검차관 입력란에 내 실명 추가 (없으면 set, 있으면 append, 이미 있으면 무시)
function fillMyName(catId) {
  if (isReadOnly.value) return;
  const myName = user.value?.name?.trim();
  if (!myName) {
    error("로그인 정보를 찾을 수 없습니다.");
    return;
  }
  // 구분자(,)로 나눠 빈 토큰을 정리한 뒤 내 이름을 토글: 있으면 제거, 없으면 추가
  const names = getInspector(catId).split(",").map((n) => n.trim()).filter(Boolean);
  const idx = names.indexOf(myName);
  if (idx === -1) names.push(myName);
  else names.splice(idx, 1);
  const newVal = names.join(", ");
  onInspectorChange(catId, newVal); // 모델 갱신 + debounced 저장 예약
  onInspectorBlur(catId); // debounce 취소 후 broadcast 포함 즉시 저장
}

// Click-to-edit memo
const editingMemo = ref(null);
const focusedItemId = ref(null);

const editedDuringFocus = new Set();
const editedMemos = new Set();

function applyRemoteAnswer(update) {
  const record = ensureAnswerRecord(update.item_id);
  record.value = update.value;
  updateAnswerMetadata(update.item_id, update);
  answerQueue.acceptVersion(update.item_id, update.version);
}

function applyDeferredAnswer(itemId) {
  const deferred = deferredAnswerUpdates.get(itemId);
  if (!deferred || focusedItemId.value === itemId || editedDuringFocus.has(itemId) || answerQueue.isDirty(itemId)) return;
  deferredAnswerUpdates.delete(itemId);
  if (Number(deferred.version) <= answerQueue.currentVersion(itemId)) return;
  applyRemoteAnswer(deferred);
}

function applyRemoteMemo(update) {
  const record = ensureAnswerRecord(update.item_id);
  record.memo = update.memo;
  updateMemoMetadata(update.item_id, update);
  memoQueue.acceptVersion(update.item_id, update.version);
}

function applyDeferredMemo(itemId) {
  const deferred = deferredMemoUpdates.get(itemId);
  if (!deferred || editingMemo.value === itemId || editedMemos.has(itemId) || memoQueue.isDirty(itemId)) return;
  deferredMemoUpdates.delete(itemId);
  if (Number(deferred.version) <= memoQueue.currentVersion(itemId)) return;
  applyRemoteMemo(deferred);
}

function handleAnswerBlur() {
  const prev = focusedItemId.value;
  focusedItemId.value = null;
  if (prev !== null) {
    editedDuringFocus.delete(prev);
    answerQueue.flush(prev);
    queueMicrotask(() => applyDeferredAnswer(prev));
  }
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
  editedMemos.delete(itemId);
  memoQueue.flush(itemId);
  queueMicrotask(() => applyDeferredMemo(itemId));
}

function retryAnswer(itemId) {
  clearConflict(answerConflicts, itemId);
  answerQueue.retry(itemId);
}

function retryMemo(itemId) {
  clearConflict(memoConflicts, itemId);
  memoQueue.retry(itemId);
}

function useServerAnswer(itemId) {
  const current = answerConflicts.value[itemId]?.current;
  if (!current) return;
  ensureAnswerRecord(itemId).value = current.value;
  updateAnswerMetadata(itemId, current);
  answerQueue.resolveWithRemote(itemId, current.version);
  clearDraft("answers", itemId);
  deferredAnswerUpdates.delete(itemId);
  clearConflict(answerConflicts, itemId);
}

function useServerMemo(itemId) {
  const current = memoConflicts.value[itemId]?.current;
  if (!current) return;
  ensureAnswerRecord(itemId).memo = current.memo;
  updateMemoMetadata(itemId, current);
  memoQueue.resolveWithRemote(itemId, current.version);
  clearDraft("memos", itemId);
  deferredMemoUpdates.delete(itemId);
  clearConflict(memoConflicts, itemId);
}

// ---- Numbering ----
import {
  catNum,
  subNum,
  grpNum,
  itemNum,
  getChecktableConfig,
  hasCheckedChecktableCell,
  nextCounterValue,
  normalizeCounterInput,
  normalizeMemo,
  formatStopwatchElapsed,
  isResponseItem,
  normalizeRestorableAnswerDraft,
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

// ---- Unanswered items ----
const missingOpen = ref(false);

const unansweredItems = computed(() => {
  const cat = currentCategory.value;
  if (!cat) return [];
  const result = getCategoryResult(cat.id);
  if (result !== "PASS") return [];
  const items = [];
  for (const [si, sub] of (cat.subcategories || []).entries()) {
    for (const [gi, grp] of (sub.groups || []).entries()) {
      for (const [ii, item] of (grp.items || []).entries()) {
        if (!isResponseItem(item)) continue;
        const itemNumber = `${subNum(si)}-${grpNum(gi)} ${itemNum(ii)}`;
        if (item.answer_type === "checktable") {
          const val = getChecktableValue(item.id);
          if (!hasCheckedChecktableCell(item, val)) {
            items.push({ id: item.id, num: itemNumber, name: item.name, sub: sub.name, grp: grp.name });
          }
        } else if (!getAnswer(item.id)) {
          items.push({ id: item.id, num: itemNumber, name: item.name, sub: sub.name, grp: grp.name });
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
  for (const [si, sub] of (cat.subcategories || []).entries()) {
    for (const [gi, grp] of (sub.groups || []).entries()) {
      for (const [ii, item] of (grp.items || []).entries()) {
        if (item.answer_type === "passfail" && getAnswer(item.id) === "FAIL") {
          items.push({ id: item.id, num: `${subNum(si)}-${grpNum(gi)} ${itemNum(ii)}`, name: item.name, sub: sub.name, grp: grp.name });
        }
      }
    }
  }
  return items;
});

const inspectionProgress = computed(() => {
  const cat = currentCategory.value;
  let completed = 0;
  let total = 0;
  if (cat) {
    for (const sub of cat.subcategories || []) {
      for (const grp of sub.groups || []) {
        for (const item of grp.items || []) {
          if (!isResponseItem(item)) continue;
          if (item.answer_type === "checktable") {
            const value = getChecktableValue(item.id);
            total += 1;
            if (hasCheckedChecktableCell(item, value)) completed += 1;
          } else {
            total += 1;
            if (getAnswer(item.id)) completed += 1;
          }
        }
      }
    }
  }
  return {
    completed,
    total,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
});

const memoOpen = ref(false);
const memoItems = computed(() => {
  const items = [];
  for (const [ci, cat] of visibleCategories.value.entries()) {
    for (const [si, sub] of (cat.subcategories || []).entries()) {
      for (const [gi, grp] of (sub.groups || []).entries()) {
        for (const [ii, item] of (grp.items || []).entries()) {
          const memo = normalizeMemo(getMemo(item.id));
          if (!memo) continue;
          items.push({
            id: item.id,
            categoryIndex: ci,
            path: `${catNumById.value[cat.id]}. ${cat.name} › ${subNum(si)}-${grpNum(gi)} ${itemNum(ii)}`,
            name: item.name,
            memo,
          });
        }
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
  activeTab.value = item.categoryIndex;
  await nextTick();
  await waitForSummaryCollapse(shouldWait);
  await scrollToItem(item.id);
}

function formatUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function scrollToItem(itemId) {
  const shouldWait = missingOpen.value || failedOpen.value;
  missingOpen.value = false;
  failedOpen.value = false;
  await nextTick();
  await waitForSummaryCollapse(shouldWait);
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
  const val = getChecktableValue(itemId);
  const key = `${rowIdx}_${colIdx}`;
  if (val[key]) {
    delete val[key];
  } else {
    val[key] = "1";
  }
  const jsonStr = JSON.stringify(val);
  ensureAnswerRecord(itemId).value = jsonStr;
  clearConflict(answerConflicts, itemId);
  setDraft("answers", itemId, jsonStr, answerQueue.currentVersion(itemId));
  answerQueue.enqueue(itemId, jsonStr, { immediate: true });
}

// ---- Quick navigation ----
const navOpen = ref(false);
const storedNavLevel = sessionStorage.getItem("inspectionQuickNavLevel");
const navLevel = ref(storedNavLevel === "subcategory" ? "subcategory" : "group");
const fabContainerRef = ref(null);

watch(navLevel, (value) => {
  sessionStorage.setItem("inspectionQuickNavLevel", value);
});

const quickNavGroups = computed(() => (
  (currentCategory.value?.subcategories || []).flatMap((sub, si) =>
    (sub.groups || []).map((group, gi) => ({
      id: group.id,
      label: `${subNum(si)}-${grpNum(gi)} ${group.name}`,
    })),
  )
));

function toggleNavLevel() {
  navLevel.value = navLevel.value === "subcategory" ? "group" : "subcategory";
}

function scrollToSub(subId) {
  navOpen.value = false;
  const el = document.getElementById(`sub-${subId}`);
  if (el) scrollBelowProgress(el);
}

function scrollToGroup(groupId) {
  navOpen.value = false;
  const el = document.getElementById(`group-${groupId}`);
  if (el) scrollBelowProgress(el);
}

function closeNavOnOutsidePointer(event) {
  const container = fabContainerRef.value;
  if (navOpen.value && container && !container.contains(event.target)) navOpen.value = false;
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
  document.addEventListener("pointerdown", closeNavOnOutsidePointer);
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  document.removeEventListener("pointerdown", closeNavOnOutsidePointer);
  if (stopwatchInterval !== null) window.clearInterval(stopwatchInterval);
  for (const timer of saveStateTimers.values()) clearTimeout(timer);
  saveStateTimers.clear();
  flushDebounce();
  answerQueue.flushAll();
  memoQueue.flushAll();
});

watch(activeTab, () => {
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
  sheetData.value.inspectors[update.category_id] = update.inspector;
});

// SSE로 개별 항목 답변 실시간 반영 (version + mutation id + 편집 가드)
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
  if (Number(update.version) <= answerQueue.currentVersion(update.item_id)) return;
  if (answerQueue.isOwnMutation(update.item_id, update.mutation_id)) {
    answerQueue.acceptVersion(update.item_id, update.version);
    updateAnswerMetadata(update.item_id, update);
    return;
  }
  if (focusedItemId.value === update.item_id || answerQueue.isDirty(update.item_id)) {
    deferredAnswerUpdates.set(update.item_id, update);
    if (answerQueue.isDirty(update.item_id)) {
      answerQueue.markConflict(update.item_id, {
        value: update.value,
        version: update.version,
        updated_at: update.updated_at,
        updated_by: update.updated_by,
      });
    }
    return;
  }
  applyRemoteAnswer(update);
});

// SSE로 메모 실시간 반영 (version + mutation id + 편집 가드)
watch(lastMemoUpdate, (update) => {
  if (!update || update.year !== year || update.team_num !== num) return;
  if (update.deleted) {
    router.replace("/");
    return;
  }
  if (Number(update.version) <= memoQueue.currentVersion(update.item_id)) return;
  if (memoQueue.isOwnMutation(update.item_id, update.mutation_id)) {
    memoQueue.acceptVersion(update.item_id, update.version);
    updateMemoMetadata(update.item_id, update);
    return;
  }
  if (editingMemo.value === update.item_id || memoQueue.isDirty(update.item_id)) {
    deferredMemoUpdates.set(update.item_id, update);
    if (memoQueue.isDirty(update.item_id)) {
      memoQueue.markConflict(update.item_id, {
        memo: update.memo,
        version: update.version,
        updated_at: update.updated_at,
        updated_by: update.updated_by,
      });
    }
    return;
  }
  applyRemoteMemo(update);
});

// Safety net watchers for deferred recovery
watch(focusedItemId, (newVal, oldVal) => {
  if (newVal !== null || oldVal === null) return;
  editedDuringFocus.delete(oldVal);
  applyDeferredAnswer(oldVal);
});

watch(editingMemo, (newVal, oldVal) => {
  if (newVal !== null || oldVal === null) return;
  editedMemos.delete(oldVal);
  applyDeferredMemo(oldVal);
});

// SSE 재연결 시 미저장 로컬 값을 보존하며 서버 데이터와 병합한다.
watch(reconnected, async () => {
  if (!reconnected.value) return;
  try {
    const data = await fetchSheetData(year, num);
    const localAnswers = sheetData.value.answers;
    for (const [rawItemId, serverRecord] of Object.entries(data.answers)) {
      const itemId = Number(rawItemId);
      const localRecord = localAnswers[itemId];
      const serverAnswer = {
        value: serverRecord.value,
        version: serverRecord.answer_version,
        updated_at: serverRecord.answer_updated_at,
        updated_by: serverRecord.answer_updated_by,
      };
      const serverMemo = {
        memo: serverRecord.memo,
        version: serverRecord.memo_version,
        updated_at: serverRecord.memo_updated_at,
        updated_by: serverRecord.memo_updated_by,
      };
      if (answerQueue.isDirty(itemId) && localRecord) {
        serverRecord.value = localRecord.value;
        if ((serverRecord.answer_version ?? 0) > (localRecord.answer_version ?? 0)) {
          answerQueue.markConflict(itemId, serverAnswer);
        }
      } else {
        answerQueue.acceptVersion(itemId, serverRecord.answer_version);
      }
      if (memoQueue.isDirty(itemId) && localRecord) {
        serverRecord.memo = localRecord.memo;
        if ((serverRecord.memo_version ?? 0) > (localRecord.memo_version ?? 0)) {
          memoQueue.markConflict(itemId, serverMemo);
        }
      } else {
        memoQueue.acceptVersion(itemId, serverRecord.memo_version);
      }
    }
    for (const [rawItemId, localRecord] of Object.entries(localAnswers)) {
      const itemId = Number(rawItemId);
      if (!data.answers[itemId] && (answerQueue.isDirty(itemId) || memoQueue.isDirty(itemId))) {
        data.answers[itemId] = localRecord;
      }
    }
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

      <!-- Current category progress -->
      <div
        v-if="inspectionProgress.total"
        class="inspection-progress"
        role="progressbar"
        :aria-valuenow="inspectionProgress.completed"
        aria-valuemin="0"
        :aria-valuemax="inspectionProgress.total"
      >
        <div class="inspection-progress-label">
          <span>진행률</span>
          <span>{{ inspectionProgress.completed }}/{{ inspectionProgress.total }} · {{ inspectionProgress.percent }}%</span>
        </div>
        <div class="inspection-progress-track">
          <div class="inspection-progress-fill" :style="{ width: `${inspectionProgress.percent}%` }"></div>
        </div>
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
              <span class="failed-item-name"><span class="item-list-num">{{ item.num }}</span> {{ item.name }}</span>
            </button>
          </div>
        </Transition>
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
              <span class="missing-item-name"><span class="item-list-num">{{ item.num }}</span> {{ item.name }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <!-- Memos in this team sheet -->
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
            <label class="inspector-label">검차관</label>
            <input
              class="form-input inspector-input"
              :value="getInspector(currentCategory.id)"
              @input="onInspectorChange(currentCategory.id, $event.target.value)"
              @blur="onInspectorBlur(currentCategory.id)"
              :disabled="isReadOnly"
              placeholder="이름"
            />
            <button
              class="btn btn-sm btn-ghost inspector-fill-btn"
              :disabled="isReadOnly"
              @click="fillMyName(currentCategory.id)"
              title="내 이름 추가/제거"
            >내 이름</button>
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
                    <div v-if="answerConflicts[item.id]" class="save-feedback save-conflict-inline">
                      <span>응답 충돌</span>
                      <div class="conflict-actions">
                        <button type="button" title="서버 값 사용" @click="useServerAnswer(item.id)">서버</button>
                        <button type="button" title="내 값 다시 저장" @click="retryAnswer(item.id)">내 값</button>
                      </div>
                    </div>
                    <div
                      v-else-if="answerSaveStates[item.id]?.state && answerSaveStates[item.id].state !== 'idle'"
                      class="save-feedback"
                      :class="`save-${answerSaveStates[item.id].state}`"
                    >
                      <span v-if="answerSaveStates[item.id].state === 'pending' || answerSaveStates[item.id].state === 'saving'">응답 저장 중…</span>
                      <span v-else-if="answerSaveStates[item.id].state === 'saved'">응답 저장됨</span>
                      <template v-else-if="answerSaveStates[item.id].state === 'error'">
                        <span>응답 저장 실패</span>
                        <button type="button" @click="retryAnswer(item.id)">재시도</button>
                      </template>
                    </div>

                    <div v-if="memoConflicts[item.id]" class="save-feedback save-conflict-inline">
                      <span>메모 충돌</span>
                      <div class="conflict-actions">
                        <button type="button" title="서버 메모 사용" @click="useServerMemo(item.id)">서버</button>
                        <button type="button" title="내 메모 다시 저장" @click="retryMemo(item.id)">내 메모</button>
                      </div>
                    </div>
                    <div
                      v-else-if="memoSaveStates[item.id]?.state && memoSaveStates[item.id].state !== 'idle'"
                      class="save-feedback"
                      :class="`save-${memoSaveStates[item.id].state}`"
                    >
                      <span v-if="memoSaveStates[item.id].state === 'pending' || memoSaveStates[item.id].state === 'saving'">메모 저장 중…</span>
                      <span v-else-if="memoSaveStates[item.id].state === 'saved'">메모 저장됨</span>
                      <template v-else-if="memoSaveStates[item.id].state === 'error'">
                        <span>메모 저장 실패</span>
                        <button type="button" @click="retryMemo(item.id)">재시도</button>
                      </template>
                    </div>
                  </div>
                  </div>

                  <!-- Memo: full content is visible below every answer control. -->
                  <div class="memo-area">
                    <button
                      type="button"
                      class="memo-text"
                      :class="{
                        'memo-empty': !normalizeMemo(getMemo(item.id)),
                        'memo-readonly': isReadOnly,
                        'memo-editing': editingMemo === item.id,
                      }"
                      :disabled="isReadOnly"
                      :title="normalizeMemo(getMemo(item.id)) && getMemoUpdatedAt(item.id) ? `${getMemoUpdatedBy(item.id)} ${formatUpdatedAt(getMemoUpdatedAt(item.id))}`.trim() : ''"
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

    <!-- Quick nav FAB -->
    <div v-if="currentCategory?.subcategories?.length" ref="fabContainerRef" class="fab-container">
      <Transition name="nav-menu">
        <div v-if="navOpen" class="nav-menu">
          <div class="nav-menu-actions">
            <button class="nav-menu-item nav-menu-level-toggle" @click="toggleNavLevel">
              {{ navLevel === "subcategory" ? "소분류 보기" : "그룹 보기" }}
            </button>
            <button class="nav-menu-item nav-menu-top" @click="scrollToTop">맨 위로</button>
          </div>
          <template v-if="navLevel === 'subcategory'">
            <button
              v-for="(sub, si) in currentCategory.subcategories"
              :key="sub.id"
              class="nav-menu-item"
              @click="scrollToSub(sub.id)"
            >{{ subNum(si) }} - {{ sub.name }}</button>
          </template>
          <template v-else>
            <button
              v-for="group in quickNavGroups"
              :key="group.id"
              class="nav-menu-item"
              @click="scrollToGroup(group.id)"
            >{{ group.label }}</button>
          </template>
        </div>
      </Transition>
      <button
        class="fab"
        :class="{ active: navOpen }"
        :aria-expanded="navOpen"
        aria-label="빠른 이동 메뉴"
        @click="navOpen = !navOpen"
      >
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

.inspector-input {
  flex: 1;
  min-width: 0;
}

.inspector-fill-btn {
  flex-shrink: 0;
  white-space: nowrap;
  align-self: stretch;
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

.pf-toggle {
  display: flex;
  gap: 0.5rem;
}

.pf-toggle button {
  min-width: 44px;
  min-height: 44px;
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

.save-feedback button,
.conflict-actions button {
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

.save-conflict-inline {
  color: var(--accent-warning);
}

.conflict-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0;
}

.inspection-progress {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem 0.125rem;
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--bg-primary);
}

.inspection-progress-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
}

.inspection-progress-track {
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-hover);
}

.inspection-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent-success);
  transition: width 0.2s ease;
}

/* Team sheet memo index */
.memo-summary {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-card);
  overflow: hidden;
}

.memo-summary-toggle {
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

.memo-summary-toggle svg {
  transition: transform 0.2s;
}

.memo-summary-toggle .chevron-open {
  transform: rotate(180deg);
}

.memo-summary-list {
  max-height: 320px;
  overflow-y: auto;
  border-top: 1px solid var(--border-color);
}

.memo-summary-item {
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

.memo-summary-item + .memo-summary-item {
  border-top: 1px solid var(--border-color);
}

.memo-summary-item:hover {
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
  min-height: 44px;
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
  min-height: 44px;
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

.item-list-num {
  font-family: "JetBrains Mono", monospace;
  color: var(--text-tertiary);
  margin-right: 0.25rem;
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
  background: var(--accent-primary-hover, #5e6ad2);
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
  min-height: 44px;
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

.nav-menu-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border-color);
}

.nav-menu-actions .nav-menu-item {
  color: var(--accent-primary);
  font-weight: 600;
  text-align: center;
}

.nav-menu-actions .nav-menu-item + .nav-menu-item {
  border-top: 0;
  border-left: 1px solid var(--border-color);
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

</style>
