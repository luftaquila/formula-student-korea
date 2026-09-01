<script setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from "vue";
import { createKeyedDebouncer } from "@shared/debounce.js";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { useRouter } from "vue-router";
import {
  fetchEntryYears,
  fetchSheetTemplate,
  fetchVehicleTypes,
  createSheetNode,
  updateSheetNode,
  deleteSheetNode,
  reorderSheetNodes,
  copySheetTemplate,
  importSheetTemplate,
} from "../api";
import { useNotification } from "@shared/useNotification.js";

const { success, error } = useNotification();
const router = useRouter();

const selectedYear = ref(currentCompetitionYear());
const availableYears = ref([]);
const template = ref([]);
const vehicleTypes = ref([]);
const loading = ref(true);
const copyFromYear = ref("");
const activeTab = ref(Number(sessionStorage.getItem("inspectionActiveTab")) || 0);

const currentCategory = computed(() => template.value[activeTab.value] || null);

const calculationSourceOptions = computed(() => {
  const options = [];
  for (const [ci, cat] of template.value.entries()) {
    for (const [si, sub] of (cat.subcategories || []).entries()) {
      for (const [gi, grp] of (sub.groups || []).entries()) {
        for (const [ii, item] of (grp.items || []).entries()) {
          if (!["number", "counter"].includes(item.answer_type) || !item.field_key) continue;
          options.push({
            item,
            key: item.field_key,
            label: `${catNum(ci)}. ${cat.name} › ${subNum(si)}-${grpNum(gi)} ${itemNum(ii)} ${item.name}`,
          });
        }
      }
    }
  }
  return options;
});

watch(activeTab, async (val) => {
  sessionStorage.setItem("inspectionActiveTab", val);
  sessionStorage.setItem("inspectionScrollY", 0);
  window.scrollTo(0, 0);
  await nextTick();
  requestAnimationFrame(resizeAllTextareas);
});

const isReadOnly = computed(() => selectedYear.value !== currentCompetitionYear());

onMounted(async () => {
  try {
    availableYears.value = await fetchEntryYears();
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
    await loadTemplate();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
  const savedY = Number(sessionStorage.getItem("inspectionScrollY")) || 0;
  await nextTick();
  requestAnimationFrame(() => window.scrollTo(0, savedY));
});

let scrollTimer = null;
function onScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    sessionStorage.setItem("inspectionScrollY", window.scrollY);
  }, 200);
}

// 뷰포트/방향 변경 시 textarea 높이 재계산 (모바일 회전·리사이즈 대응)
let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeAllTextareas, 150);
}

onMounted(() => {
  window.addEventListener("scroll", onScroll);
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("orientationchange", onResize);
  flushSaves(); // 대기 중인 저장을 즉시 실행 — 이탈로 인한 입력 유실 방지
});

async function loadTemplate() {
  try {
    const [tmpl, vtList] = await Promise.all([
      fetchSheetTemplate(selectedYear.value),
      fetchVehicleTypes(selectedYear.value).catch(() => []),
    ]);
    template.value = tmpl;
    vehicleTypes.value = vtList;
  } catch (e) {
    template.value = [];
    vehicleTypes.value = [];
  }
  if (activeTab.value >= template.value.length) {
    activeTab.value = Math.max(0, template.value.length - 1);
  }
  await nextTick();
  requestAnimationFrame(resizeAllTextareas);
}

function resizeAllTextareas() {
  document.querySelectorAll(".item-textarea").forEach((el) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });
}

async function onYearChange() {
  loading.value = true;
  await loadTemplate();
  loading.value = false;
}

async function handleCopy() {
  if (!copyFromYear.value) return;
  try {
    await copySheetTemplate(Number(copyFromYear.value), selectedYear.value);
    success("템플릿이 복사되었습니다.");
    await loadTemplate();
  } catch (e) {
    error(e.message || "복사에 실패했습니다.");
  }
  copyFromYear.value = "";
}

async function addCategory() {
  try {
    const maxOrder = template.value.reduce((m, c) => Math.max(m, c.sort_order), -1);
    const { id } = await createSheetNode({
      year: selectedYear.value,
      level: "category",
      name: "새 카테고리",
      sort_order: maxOrder + 1,
    });
    template.value.push({
      id, name: "새 카테고리", level: "category",
      year: selectedYear.value, sort_order: maxOrder + 1,
      pdf_include: 1, excluded_types: [], subcategories: [],
    });
    activeTab.value = template.value.length - 1;
  } catch (e) {
    error("추가에 실패했습니다.");
  }
}

async function addChild(parent, level, childKey) {
  const children = parent[childKey];
  const maxOrder = children.reduce((m, c) => Math.max(m, c.sort_order), -1);
  const defaultName = level === "subcategory" ? "새 소분류" : level === "group" ? "새 그룹" : "새 항목";
  try {
    const data = {
      year: selectedYear.value,
      level,
      parent_id: parent.id,
      name: defaultName,
      sort_order: maxOrder + 1,
    };
    if (level === "item") data.answer_type = "passfail";
    const { id, field_key } = await createSheetNode(data);
    const newNode = { id, field_key, name: defaultName, level, sort_order: maxOrder + 1, year: selectedYear.value, parent_id: parent.id };
    if (level === "subcategory") { newNode.groups = []; newNode.remarks = ""; }
    else if (level === "group") newNode.items = [];
    else if (level === "item") { newNode.answer_type = "passfail"; newNode.remarks = ""; newNode.unit = ""; newNode.calculation = null; }
    children.push(newNode);
  } catch (e) {
    error("추가에 실패했습니다.");
  }
}

async function removeNode(arr, idx) {
  const node = arr[idx];
  if (!confirm(`"${node.name}" 항목을 삭제하시겠습니까? 하위 항목도 모두 삭제됩니다.`)) return;
  try {
    await deleteSheetNode(node.id);
    arr.splice(idx, 1);
    // Adjust activeTab when deleting a category
    if (arr === template.value && activeTab.value >= template.value.length) {
      activeTab.value = Math.max(0, template.value.length - 1);
    }
  } catch (e) {
    error("삭제에 실패했습니다.");
  }
}

// ---- Drag & Drop ----
const dragState = ref(null); // { arr, index }

function onHandleMouseDown(evt) {
  const container = evt.target.closest("[data-drag-container]");
  if (container) container.draggable = true;
}

function onDragStart(evt, arr, index) {
  dragState.value = { arr, index };
  evt.dataTransfer.effectAllowed = "move";
  evt.target.classList.add("dragging");
}

function onDragEnd(evt) {
  evt.target.classList.remove("dragging");
  evt.target.draggable = false;
  dragState.value = null;
}

function onDragOver(evt, arr, index) {
  if (!dragState.value || dragState.value.arr !== arr) return;
  evt.preventDefault();
  evt.dataTransfer.dropEffect = "move";
}

async function onDrop(evt, arr, toIndex) {
  evt.preventDefault();
  if (!dragState.value || dragState.value.arr !== arr) return;

  const fromIndex = dragState.value.index;
  if (fromIndex === toIndex) return;

  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, moved);

  const items = arr.map((n, i) => ({ id: n.id, sort_order: i }));
  arr.forEach((n, i) => (n.sort_order = i));

  try {
    await reorderSheetNodes(items);
  } catch (e) {
    error("순서 변경에 실패했습니다.");
  }

  dragState.value = null;
}

// ---- Inline editing ----
// 키 단위 디바운스: SheetDetail과 동일하게 언마운트 시 flush해 저장 유실을 막는다.
const { debounce: debounceSave, flush: flushSaves } = createKeyedDebouncer(500);

function onNameChange(node) {
  debounceSave(`name-${node.id}`, async () => {
    try {
      await updateSheetNode(node.id, { name: node.name });
    } catch (e) {
      error("이름 변경에 실패했습니다.");
    }
  });
}

async function onAnswerTypeChange(item) {
  try {
    if (item.answer_type !== "number") item.calculation = null;
    if (item.answer_type === "checktable" && !item.remarks.startsWith("{")) {
      item.remarks = JSON.stringify({ columns: [], rows: [] });
      await updateSheetNode(item.id, { answer_type: item.answer_type, remarks: item.remarks, calculation: null });
    } else {
      await updateSheetNode(item.id, { answer_type: item.answer_type, calculation: item.calculation });
    }
  } catch (e) {
    error("유형 변경에 실패했습니다.");
  }
}

function onRemarksChange(item) {
  debounceSave(`remarks-${item.id}`, async () => {
    try {
      await updateSheetNode(item.id, { remarks: item.remarks });
    } catch (e) {
      error("비고 변경에 실패했습니다.");
    }
  });
}

async function onPdfIncludeChange(cat) {
  try {
    await updateSheetNode(cat.id, { pdf_include: cat.pdf_include });
  } catch (e) {
    error("변경에 실패했습니다.");
  }
}

// 카테고리 표시 유형: 제외 목록으로 저장하므로 목록에 없으면 표시된다.
// 유형을 새로 추가하면 기존 카테고리에 자동으로 체크된 상태가 된다.
function isTypeVisible(cat, typeName) {
  return !(cat.excluded_types || []).includes(typeName);
}

async function onTypeVisibleChange(cat, typeName, visible) {
  const prev = cat.excluded_types || [];
  const next = visible ? prev.filter(t => t !== typeName) : [...prev, typeName];
  cat.excluded_types = next;
  try {
    await updateSheetNode(cat.id, { excluded_types: next });
  } catch (e) {
    cat.excluded_types = prev; // 저장 실패 시 체크박스를 원래 상태로 되돌린다.
    error("표시 유형 변경에 실패했습니다.");
  }
}

function onUnitChange(item) {
  debounceSave(`unit-${item.id}`, async () => {
    try {
      await updateSheetNode(item.id, { unit: item.unit });
    } catch (e) {
      error("단위 변경에 실패했습니다.");
    }
  });
}

function sourceOptionsFor(item) {
  return calculationSourceOptions.value.filter(option => option.item.id !== item.id);
}

function defaultCalculation(item, mode, operation = "multiply") {
  const source = sourceOptionsFor(item)[0]?.key;
  if (!source) return null;
  const config = { mode, operation, sources: [source], precision: operation === "range_lookup" ? 0 : 2 };
  if (operation === "multiply") config.factor = 1;
  if (operation === "range_lookup") config.ranges = [{ max: 100, value: 0 }];
  return config;
}

async function setCalculationMode(item, mode) {
  const fallback = defaultCalculation(item, mode);
  const next = calculationForMode(item.calculation, mode, fallback);
  if (mode !== "manual" && !next) {
    error("먼저 원본으로 사용할 숫자 문항을 추가하세요.");
    return;
  }
  item.calculation = next;
  await saveCalculation(item);
}

async function setCalculationOperation(item, operation) {
  const next = defaultCalculation(item, item.calculation.mode, operation);
  if (!next) return;
  const existingSources = calculationSourcesForOperation(
    item.calculation.sources,
    operation,
    sourceOptionsFor(item).map(option => option.key),
  );
  if (existingSources.length) next.sources = existingSources;
  item.calculation = next;
  await saveCalculation(item);
}

async function saveCalculation(item) {
  try {
    await updateSheetNode(item.id, { calculation: item.calculation });
  } catch (e) {
    error(e.message || "계산 설정 저장에 실패했습니다.");
  }
}

function onCalculationChange(item) {
  debounceSave(`calculation-${item.id}`, () => saveCalculation(item));
}

function addCalculationRange(item) {
  const lastMax = Number(item.calculation.ranges.at(-1)?.max) || 0;
  item.calculation.ranges.push({ max: lastMax + 100, value: 0 });
  onCalculationChange(item);
}

function removeCalculationRange(item, index) {
  if (item.calculation.ranges.length <= 1) return;
  item.calculation.ranges.splice(index, 1);
  onCalculationChange(item);
}

function onItemNameInput(evt, node) {
  const el = evt.target;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
  onNameChange(node);
}

// ---- Checktable helpers ----
function setChecktableConfig(item, config) {
  item.remarks = JSON.stringify(config);
  onRemarksChange(item);
}

function onChecktableColumnsChange(item, value) {
  debounceSave(`col-${item.id}`, () => {
    const config = getChecktableConfig(item);
    config.columns = value.split(",").map(s => s.trim()).filter(Boolean);
    setChecktableConfig(item, config);
  });
}

function onChecktableRowsChange(item, value) {
  debounceSave(`row-${item.id}`, () => {
    const config = getChecktableConfig(item);
    config.rows = value.split(",").map(s => s.trim()).filter(Boolean);
    setChecktableConfig(item, config);
  });
}

// ---- Numbering ----
import {
  catNum,
  subNum,
  grpNum,
  itemNum,
  getChecktableConfig,
  isMultiSourceCalculation,
  calculationForMode,
  calculationSourcesForOperation,
} from "../utils/sheet-helpers";

// ---- Print ----
function openPrintPage() {
  const base = import.meta.env.PROD ? "/inspection" : "";
  window.open(`${base}/template/print?year=${selectedYear.value}`, "_blank");
}

// ---- JSON Export / Import ----
function stripIds(tree) {
  return tree.map(cat => ({
    name: cat.name,
    remarks: cat.remarks || "",
    pdf_include: cat.pdf_include ?? 1,
    excluded_types: cat.excluded_types || [],
    subcategories: (cat.subcategories || []).map(sub => ({
      name: sub.name,
      remarks: sub.remarks || "",
      groups: (sub.groups || []).map(grp => ({
        name: grp.name,
        remarks: grp.remarks || "",
        items: (grp.items || []).map(item => ({
          name: item.name,
          answer_type: item.answer_type || "passfail",
          remarks: item.remarks || "",
          unit: item.unit || "",
          field_key: item.field_key,
          calculation: item.calculation || null,
        })),
      })),
    })),
  }));
}

function exportJson() {
  const data = stripIds(template.value);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inspection-template-${selectedYear.value}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson() {
  if (!confirm("JSON 파일에서 템플릿을 가져옵니다. 기존 템플릿이 있는 경우 모두 삭제되고 새로 덮어씁니다. 계속하시겠습니까?")) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("JSON 배열이 아닙니다.");
      await importSheetTemplate(selectedYear.value, data);
      success("템플릿을 가져왔습니다.");
      activeTab.value = 0;
      await loadTemplate();
    } catch (e) {
      error(e.message || "가져오기에 실패했습니다.");
    }
  };
  input.click();
}

function goBack() {
  router.push("/");
}
</script>

<template>
  <div class="template-page">
    <div class="top-actions">
      <button class="btn btn-ghost back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="m15 18-6-6 6-6" />
        </svg>
        돌아가기
      </button>
      <div class="top-actions-right">
        <button class="btn btn-primary btn-sm" @click="openPrintPage" :disabled="loading || !template.length">인쇄</button>
        <button class="btn btn-ghost btn-sm" @click="exportJson" :disabled="loading || !template.length">JSON 내보내기</button>
        <button v-if="!isReadOnly" class="btn btn-ghost btn-sm" @click="importJson" :disabled="loading">JSON 가져오기</button>
      </div>
    </div>

    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label">연도</label>
        <select class="filter-input" v-model.number="selectedYear" @change="onYearChange">
          <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
        </select>
      </div>
      <div v-if="!isReadOnly && template.length === 0" class="filter-group">
        <label class="filter-label">이전 연도 복사</label>
        <div class="copy-row">
          <select class="filter-input" v-model="copyFromYear">
            <option value="">선택</option>
            <option v-for="y in availableYears.filter(y => y !== selectedYear)" :key="y" :value="y">{{ y }}년</option>
          </select>
          <button class="btn btn-primary btn-sm" :disabled="!copyFromYear" @click="handleCopy">복사</button>
        </div>
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>

    <template v-else>
      <div v-if="template.length === 0 && !isReadOnly" class="empty-state-box">
        <p>템플릿이 없습니다.</p>
        <button class="btn btn-primary" @click="addCategory">카테고리 추가</button>
      </div>

      <!-- Category Tabs -->
      <div class="tabs" v-if="template.length > 0">
        <button
          v-for="(cat, idx) in template"
          :key="cat.id"
          class="tab"
          :class="{ active: activeTab === idx }"
          @click="activeTab = idx"
          data-drag-container
          @dragstart="onDragStart($event, template, idx)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, template, idx)"
          @drop="onDrop($event, template, idx)"
        >
          <span v-if="!isReadOnly" class="tab-drag-handle" @mousedown="onHandleMouseDown" title="드래그하여 순서 변경">⠿</span>
          {{ catNum(idx) }}. {{ cat.name }}
        </button>
        <button v-if="!isReadOnly" class="tab tab-add" @click="addCategory" title="카테고리 추가">+</button>
      </div>

      <!-- Category Panel -->
      <div v-if="currentCategory" class="card category-panel">
        <div class="card-header category-header">
          <div class="node-row">
            <span class="node-num cat-num">{{ catNum(activeTab) }}.</span>
            <input
              class="node-name-input cat-name"
              v-model="currentCategory.name"
              @input="onNameChange(currentCategory)"
              :disabled="isReadOnly"
              placeholder="카테고리명"
            />
            <label v-if="!isReadOnly" class="pdf-toggle" title="PDF 내보내기에 포함">
              <input type="checkbox" :checked="currentCategory.pdf_include" @change="currentCategory.pdf_include = $event.target.checked ? 1 : 0; onPdfIncludeChange(currentCategory)" />
              <span class="pdf-toggle-label">PDF</span>
            </label>
            <div class="node-actions" v-if="!isReadOnly">
              <button class="btn btn-danger btn-sm" @click="removeNode(template, activeTab)">삭제</button>
            </div>
          </div>
          <div v-if="vehicleTypes.length" class="type-visibility-row">
            <span class="type-visibility-label">표시 유형</span>
            <label
              v-for="vt in vehicleTypes"
              :key="vt.id"
              class="type-toggle"
              :class="{ 'type-hidden': !isTypeVisible(currentCategory, vt.name) }"
            >
              <input
                type="checkbox"
                :checked="isTypeVisible(currentCategory, vt.name)"
                :disabled="isReadOnly"
                @change="onTypeVisibleChange(currentCategory, vt.name, $event.target.checked)"
              />
              <span class="badge" :class="'badge-type-' + vt.color">{{ vt.name }}</span>
            </label>
          </div>
        </div>
        <div class="card-body category-body">
          <!-- Subcategories -->
          <div
            v-for="(sub, si) in currentCategory.subcategories"
            :key="sub.id"
            class="subcategory-section"
            data-drag-container
            @dragstart.stop="onDragStart($event, currentCategory.subcategories, si)"
            @dragend="onDragEnd"
            @dragover.stop="onDragOver($event, currentCategory.subcategories, si)"
            @drop.stop="onDrop($event, currentCategory.subcategories, si)"
          >
            <div class="node-row sub-row">
              <span v-if="!isReadOnly" class="drag-handle" @mousedown="onHandleMouseDown" title="드래그하여 순서 변경">⠿</span>
              <span class="node-num sub-num">{{ subNum(si) }} -</span>
              <input
                class="node-name-input sub-name"
                v-model="sub.name"
                @input="onNameChange(sub)"
                :disabled="isReadOnly"
                placeholder="소분류명"
              />
              <input
                class="node-name-input remarks-input"
                v-model="sub.remarks"
                @input="onRemarksChange(sub)"
                :disabled="isReadOnly"
                placeholder="비고"
              />
              <div class="node-actions" v-if="!isReadOnly">
                <button class="btn btn-danger btn-sm" @click="removeNode(currentCategory.subcategories, si)">삭제</button>
              </div>
            </div>

            <!-- Groups -->
            <div
              v-for="(grp, gi) in sub.groups"
              :key="grp.id"
              class="group-section"
              data-drag-container
              @dragstart.stop="onDragStart($event, sub.groups, gi)"
              @dragend="onDragEnd"
              @dragover.stop="onDragOver($event, sub.groups, gi)"
              @drop.stop="onDrop($event, sub.groups, gi)"
            >
              <div class="node-row grp-row">
                <span v-if="!isReadOnly" class="drag-handle" @mousedown="onHandleMouseDown" title="드래그하여 순서 변경">⠿</span>
                <span class="node-num grp-num">{{ grpNum(gi) }}.</span>
                <input
                  class="node-name-input grp-name"
                  v-model="grp.name"
                  @input="onNameChange(grp)"
                  :disabled="isReadOnly"
                  placeholder="그룹명"
                />
                <input
                  class="node-name-input remarks-input"
                  v-model="grp.remarks"
                  @input="onRemarksChange(grp)"
                  :disabled="isReadOnly"
                  placeholder="비고"
                />
                <div class="node-actions" v-if="!isReadOnly">
                  <button class="btn btn-danger btn-sm" @click="removeNode(sub.groups, gi)">삭제</button>
                </div>
              </div>

              <!-- Items -->
              <div
                v-for="(item, ii) in grp.items"
                :key="item.id"
                class="item-row"
                data-drag-container
                @dragstart.stop="onDragStart($event, grp.items, ii)"
                @dragend="onDragEnd"
                @dragover.stop="onDragOver($event, grp.items, ii)"
                @drop.stop="onDrop($event, grp.items, ii)"
              >
                <div class="node-row">
                  <span v-if="!isReadOnly" class="drag-handle" @mousedown="onHandleMouseDown" title="드래그하여 순서 변경">⠿</span>
                  <span class="node-num item-num">{{ itemNum(ii) }}</span>
                  <textarea
                    class="node-name-input item-name item-textarea"
                    v-model="item.name"
                    @input="onItemNameInput($event, item)"
                    :disabled="isReadOnly"
                    placeholder="항목명"
                    rows="1"
                  ></textarea>
                  <select
                    class="filter-input type-select"
                    v-model="item.answer_type"
                    @change="onAnswerTypeChange(item)"
                    :disabled="isReadOnly"
                  >
                    <option value="passfail">PASS/FAIL/N/A</option>
                    <option value="number">숫자</option>
                    <option value="counter">증감 숫자</option>
                    <option value="text">텍스트</option>
                    <option value="checktable">체크 테이블</option>
                    <option value="stopwatch">스톱워치</option>
                  </select>
                  <input
                    v-if="item.answer_type === 'number' || item.answer_type === 'counter' || item.answer_type === 'text'"
                    class="node-name-input unit-input"
                    v-model="item.unit"
                    @input="onUnitChange(item)"
                    :disabled="isReadOnly"
                    placeholder="단위"
                  />
                  <input
                    v-if="item.answer_type !== 'checktable'"
                    class="node-name-input remarks-input"
                    v-model="item.remarks"
                    @input="onRemarksChange(item)"
                    :disabled="isReadOnly"
                    placeholder="비고"
                  />
                  <button v-if="!isReadOnly" class="btn btn-danger btn-sm" @click="removeNode(grp.items, ii)">삭제</button>
                </div>
                <!-- Checktable config -->
                <div v-if="item.answer_type === 'checktable'" class="checktable-config">
                  <div class="checktable-field">
                    <label class="checktable-label">열 (쉼표 구분)</label>
                    <input
                      class="node-name-input"
                      :value="getChecktableConfig(item).columns.join(', ')"
                      @input="onChecktableColumnsChange(item, $event.target.value)"
                      :disabled="isReadOnly"
                      placeholder="증빙자료, Pipe시트, 연료호스, ..."
                    />
                  </div>
                  <div class="checktable-field">
                    <label class="checktable-label">행 (쉼표 구분)</label>
                    <input
                      class="node-name-input"
                      :value="getChecktableConfig(item).rows.join(', ')"
                      @input="onChecktableRowsChange(item, $event.target.value)"
                      :disabled="isReadOnly"
                      placeholder="사전검토, 현장검토, ..."
                    />
                  </div>
                  <div class="checktable-preview" v-if="getChecktableConfig(item).columns.length && getChecktableConfig(item).rows.length">
                    <table class="checktable-preview-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th v-for="col in getChecktableConfig(item).columns" :key="col">{{ col }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="row in getChecktableConfig(item).rows" :key="row">
                          <td class="checktable-row-header">{{ row }}</td>
                          <td v-for="col in getChecktableConfig(item).columns" :key="col" class="checktable-cell">
                            <input type="checkbox" disabled />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <!-- Number calculation config: users select safe operations and source fields; arbitrary code is never stored. -->
                <div v-if="item.answer_type === 'number'" class="calculation-config">
                  <div class="calculation-header">
                    <label class="calculation-label">값 연동</label>
                    <select
                      class="filter-input calculation-mode"
                      :value="item.calculation?.mode || 'manual'"
                      :disabled="isReadOnly"
                      @change="setCalculationMode(item, $event.target.value)"
                    >
                      <option value="manual">직접 입력</option>
                      <option value="computed">자동 계산 (읽기 전용)</option>
                      <option value="suggestion">권장값 표시 + 실측 입력</option>
                    </select>
                  </div>
                  <template v-if="item.calculation">
                    <div class="calculation-fields">
                      <label class="calculation-field">
                        <span>계산 방식</span>
                        <select
                          class="filter-input"
                          :value="item.calculation.operation"
                          :disabled="isReadOnly"
                          @change="setCalculationOperation(item, $event.target.value)"
                        >
                          <option value="multiply">원본 × 고정값</option>
                          <option value="sum">원본들의 합</option>
                          <option value="product">원본들의 곱</option>
                          <option value="range_lookup">구간별 값</option>
                        </select>
                      </label>
                      <label class="calculation-field calculation-source-field">
                        <span>원본 문항</span>
                        <select
                          v-if="isMultiSourceCalculation(item.calculation.operation)"
                          class="filter-input"
                          multiple
                          :size="Math.min(4, sourceOptionsFor(item).length)"
                          v-model="item.calculation.sources"
                          :disabled="isReadOnly"
                          @change="saveCalculation(item)"
                        >
                          <option v-for="option in sourceOptionsFor(item)" :key="option.key" :value="option.key">{{ option.label }}</option>
                        </select>
                        <select
                          v-else
                          class="filter-input"
                          v-model="item.calculation.sources[0]"
                          :disabled="isReadOnly"
                          @change="saveCalculation(item)"
                        >
                          <option v-for="option in sourceOptionsFor(item)" :key="option.key" :value="option.key">{{ option.label }}</option>
                        </select>
                      </label>
                      <label v-if="item.calculation.operation === 'multiply'" class="calculation-field compact">
                        <span>곱할 값</span>
                        <input class="node-name-input" type="number" step="any" v-model.number="item.calculation.factor" :disabled="isReadOnly" @input="onCalculationChange(item)" />
                      </label>
                      <label class="calculation-field compact">
                        <span>소수 자릿수</span>
                        <input class="node-name-input" type="number" min="0" max="6" step="1" v-model.number="item.calculation.precision" :disabled="isReadOnly" @input="onCalculationChange(item)" />
                      </label>
                    </div>
                    <div v-if="item.calculation.operation === 'range_lookup'" class="calculation-ranges">
                      <div class="range-heading"><span>원본 상한 (이하)</span><span>결과값</span></div>
                      <div v-for="(range, ri) in item.calculation.ranges" :key="ri" class="range-row">
                        <input class="node-name-input" type="number" step="any" v-model.number="range.max" :disabled="isReadOnly" @input="onCalculationChange(item)" />
                        <span>→</span>
                        <input class="node-name-input" type="number" step="any" v-model.number="range.value" :disabled="isReadOnly" @input="onCalculationChange(item)" />
                        <button v-if="!isReadOnly" type="button" class="btn btn-danger btn-sm" :disabled="item.calculation.ranges.length <= 1" @click="removeCalculationRange(item, ri)">삭제</button>
                      </div>
                      <button v-if="!isReadOnly" type="button" class="btn btn-ghost btn-sm" @click="addCalculationRange(item)">+ 구간</button>
                    </div>
                  </template>
                </div>
              </div>

              <button v-if="!isReadOnly" class="btn btn-ghost btn-sm add-child-btn" @click="addChild(grp, 'item', 'items')">+ 항목</button>
            </div>

            <button v-if="!isReadOnly" class="btn btn-ghost btn-sm add-child-btn" @click="addChild(sub, 'group', 'groups')">+ 그룹</button>
          </div>

          <button v-if="!isReadOnly" class="btn btn-ghost btn-sm add-child-btn" @click="addChild(currentCategory, 'subcategory', 'subcategories')">+ 소분류</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.template-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.top-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.back-btn {
  align-self: flex-start;
}

.top-actions-right {
  display: flex;
  gap: 0.5rem;
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

.copy-row {
  display: flex;
  gap: 0.5rem;
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

.empty-state-box {
  text-align: center;
  padding: 3rem;
  color: var(--text-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
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
  gap: 0.375rem;
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

.tab.dragging {
  opacity: 0.4;
}

.tab-add {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 0.5rem 0.75rem;
}

.tab-add:hover {
  color: var(--accent-primary);
}

.tab-drag-handle {
  cursor: grab;
  user-select: none;
  font-size: 0.875rem;
  color: var(--text-tertiary);
  line-height: 1;
  letter-spacing: -1px;
}

.tab-drag-handle:active {
  cursor: grabbing;
}

/* Category Panel */
.category-panel {
  margin-bottom: 0;
}

.category-header {
  padding: 0.75rem 1rem !important;
}

.category-body {
  padding: 0.5rem 1rem 1rem !important;
}

.node-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 36px;
}

.drag-handle {
  cursor: grab;
  user-select: none;
  font-size: 1.125rem;
  color: var(--text-tertiary);
  flex-shrink: 0;
  line-height: 1;
  letter-spacing: -1px;
}

.node-num {
  flex-shrink: 0;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  color: var(--text-tertiary);
  user-select: none;
}

.cat-num { font-size: 1rem; color: var(--accent-primary); }
.sub-num { font-size: 0.875rem; color: var(--text-secondary); }
.grp-num { font-size: 0.8125rem; color: var(--text-tertiary); }
.item-num { font-size: 0.8125rem; }

.drag-handle:active {
  cursor: grabbing;
}

.dragging {
  opacity: 0.4;
}

.node-name-input {
  flex: 1;
  min-width: 0;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.875rem;
  background: var(--bg-input);
  color: var(--text-primary);
}

.node-name-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.node-name-input:disabled {
  opacity: 0.7;
  cursor: default;
}

.cat-name {
  font-weight: 700;
  font-size: 1rem;
}

.sub-name {
  font-weight: 600;
}

.node-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.subcategory-section {
  margin-top: 0.75rem;
  padding-left: 1.5rem;
  border-left: 2px solid var(--border-color);
}

.subcategory-section.dragging {
  opacity: 0.4;
}

.group-section {
  margin-top: 0.5rem;
  padding-left: 1.5rem;
  border-left: 2px solid var(--border-color);
}

.group-section.dragging {
  opacity: 0.4;
}

.item-row {
  margin-top: 0.375rem;
  padding-left: 1.5rem;
}

.item-row.dragging {
  opacity: 0.4;
}

.item-textarea {
  resize: none;
  overflow: hidden;
  line-height: 1.4;
  font-family: inherit;
  word-break: keep-all;
  overflow-wrap: break-word;
}

.type-select {
  width: 110px;
  flex-shrink: 0;
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
}

.pdf-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
}

.pdf-toggle input {
  accent-color: var(--accent-primary);
}

.pdf-toggle-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.type-visibility-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.type-visibility-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}

.type-toggle {
  display: flex;
  align-items: center;
  gap: 0.3125rem;
  cursor: pointer;
  user-select: none;
}

.type-toggle input {
  accent-color: var(--accent-primary);
  cursor: pointer;
}

.type-toggle input:disabled {
  cursor: default;
}

/* 체크 해제된 유형은 배지를 흐리게 — 어떤 유형에 숨겨졌는지 한눈에 보이게 한다. */
.type-toggle.type-hidden .badge {
  opacity: 0.35;
}

.unit-input {
  max-width: 80px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.remarks-input {
  max-width: 200px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.add-child-btn {
  margin-top: 0.5rem;
}

/* Checktable config */
.checktable-config {
  margin-top: 0.375rem;
  padding-left: 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.checktable-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.checktable-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  white-space: nowrap;
  min-width: 90px;
}

.checktable-preview {
  margin-top: 0.25rem;
  overflow-x: auto;
}

.checktable-preview-table {
  border-collapse: collapse;
  font-size: 0.75rem;
}

.checktable-preview-table th,
.checktable-preview-table td {
  border: 1px solid var(--border-color);
  padding: 0.25rem 0.5rem;
  text-align: center;
  white-space: nowrap;
}

.checktable-preview-table th {
  background: var(--bg-secondary);
  font-weight: 600;
  font-size: 0.6875rem;
}

.checktable-row-header {
  font-weight: 600;
  text-align: left !important;
  background: var(--bg-secondary);
  font-size: 0.6875rem;
}

.checktable-cell input {
  accent-color: var(--accent-primary);
}

.calculation-config {
  margin: 0.5rem 0 0 2rem;
  padding: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.calculation-header,
.calculation-fields,
.range-row,
.range-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.calculation-label,
.calculation-field > span,
.range-heading {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.calculation-mode {
  min-width: 190px;
}

.calculation-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 160px;
}

.calculation-source-field {
  flex: 1;
  min-width: 280px;
}

.calculation-source-field select[multiple] {
  min-height: 5rem;
}

.calculation-field.compact {
  min-width: 90px;
  max-width: 120px;
}

.calculation-ranges {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
}

.range-heading {
  padding-left: 0.125rem;
}

.range-heading span {
  width: 120px;
}

.range-row .node-name-input {
  width: 120px;
  flex: 0 0 120px;
}

@media (max-width: 640px) {
  .top-actions {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .top-actions-right {
    flex-wrap: wrap;
  }

  .subcategory-section,
  .group-section,
  .item-row {
    padding-left: 0.75rem;
  }

  .node-row {
    flex-wrap: wrap;
  }

  .calculation-config {
    margin-left: 0.75rem;
  }

  .calculation-source-field {
    min-width: 100%;
  }

  .item-textarea {
    flex-basis: 100%;
  }

  .node-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .type-select {
    width: 90px;
  }

  .remarks-input {
    max-width: 100%;
  }
}
</style>
