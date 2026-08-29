<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { fetchEntryYears, fetchEntries, fetchEndurance, fetchScore, fetchVehicleTypes, updateEndurance, updateSetting } from "../api";
import { exportTable } from "../composables/exportTable";
import { useNotification } from "@shared/useNotification.js";
import { useStickyColumns } from "@shared/useStickyColumns.js";
import StickyFreezeLine from "@shared/StickyFreezeLine.vue";
import ConfirmableInput from "../components/ConfirmableInput.vue";
import { useTableHeadBand } from "../composables/useTableHeadBand";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { useSSE } from "../composables/useSSE";

const { error } = useNotification();
const { lastEnduranceUpdate, lastPenaltyUpdate, lastSettingUpdate, reconnected } = useSSE();

const tableRef = ref(null);
const headScrollerRef = ref(null);
const { stickyCols, lineX, startDrag } = useStickyColumns({
  storageKey: "score-endurance-sticky-cols",
  tableRef,
  scrollerRef: headScrollerRef,
  columnSelectors: [".col-num", ".col-team"],
});

const headBandRef = ref(null);
useTableHeadBand({ tableRef, scrollerRef: headScrollerRef, bandRef: headBandRef });

const selectedYear = ref(currentCompetitionYear());
const availableYears = ref([]);
const loading = ref(true);
const searchQuery = ref("");
const typeFilters = ref({});
const typeColorMap = ref({});
const showQualifiedOnly = ref(false);

const entries = ref({});
const endurance = ref({});
const penalties = ref({});
const settings = ref({});
const energy = ref({ teams: {}, config: {}, references: {} });
const focusedCell = ref(null); // { num, field }
const deferredEnduranceUpdate = ref(null);
const configEditing = ref(false);
const configEditingValue = ref(null);
let cellEdited = false;
// score 스냅샷과 내구 입력 조회는 적용 세대를 따로 관리한다.
// 부분 score 재조회가 더 최신이어도 진행 중이던 전체 조회의 내구 입력은 안전하게 적용한다.
let scoreSnapshotSeq = 0;
let enduranceFetchSeq = 0;

const isReadOnly = computed(() => selectedYear.value !== currentCompetitionYear());

const vehicleTypes = computed(() => {
  const types = new Set();
  for (const entry of Object.values(entries.value)) {
    if (entry.type) types.add(entry.type);
  }
  return [...types].sort();
});

watch(vehicleTypes, (types) => {
  for (const type of types) {
    if (!(type in typeFilters.value)) typeFilters.value[type] = true;
  }
});

const entryList = computed(() => {
  let list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  if (vehicleTypes.value.length > 0) {
    list = list.filter((entry) => !entry.type || typeFilters.value[entry.type] !== false);
  }
  if (showQualifiedOnly.value) {
    list = list.filter((entry) => !!getField(entry.num, "qualified"));
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(e => String(e.num).includes(q) || (e.univ || "").toLowerCase().includes(q) || (e.team || "").toLowerCase().includes(q));
  }
  return list.sort((a, b) => a.num - b.num);
});

watch(entryList, (list) => {
  const editingNum = focusedCell.value?.num;
  if (editingNum != null && !list.some(({ num }) => num === editingNum)) handleCellBlur();
}, { flush: "sync" });

onMounted(async () => {
  try {
    availableYears.value = await fetchEntryYears();
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
    await loadData();
  } catch {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
});

async function loadData() {
  const year = selectedYear.value;
  const scoreSeq = ++scoreSnapshotSeq;
  const enduranceSeq = ++enduranceFetchSeq;
  try {
    const [entryData, enduranceData, scoreData, vehicleTypeData] = await Promise.all([
      fetchEntries(year),
      fetchEndurance(year),
      fetchScore(year),
      fetchVehicleTypes(year).catch(() => []),
    ]);
    if (selectedYear.value !== year) return;
    if (enduranceSeq === enduranceFetchSeq) endurance.value = enduranceData;
    if (scoreSeq === scoreSnapshotSeq) {
      // 입력 적용 유형과 에너지 계산 결과를 동일한 score 스냅샷에서 가져온다.
      entries.value = scoreData.entries || entryData;
      penalties.value = scoreData.penalties || {};
      settings.value = scoreData.settings || {};
      energy.value = scoreData.energy || { teams: {}, config: {}, references: {} };
      typeColorMap.value = Object.fromEntries(vehicleTypeData.map((type) => [type.name, type.color]));
    }
  } catch {
    if (selectedYear.value === year && (scoreSeq === scoreSnapshotSeq || enduranceSeq === enduranceFetchSeq)) {
      error("데이터를 가져올 수 없습니다.");
    }
  }
}

async function onYearChange() {
  clearTimeout(scoreRefreshTimer);
  cancelConfigEdit();
  handleCellBlur();
  loading.value = true;
  await loadData();
  loading.value = false;
}

// SSE (편집 가드: 포커스된 셀은 deferred)
watch(lastEnduranceUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete endurance.value[update.team_num];
    if (focusedCell.value?.num === update.team_num) {
      focusedCell.value = null;
      deferredEnduranceUpdate.value = null;
      cellEdited = false;
    }
    loadData();
    return;
  }
  if (update.renumbered) {
    if (endurance.value[update.prevNum]) {
      endurance.value[update.team_num] = endurance.value[update.prevNum];
      delete endurance.value[update.prevNum];
    }
    if (focusedCell.value?.num === update.prevNum) {
      focusedCell.value = { ...focusedCell.value, num: update.team_num };
    }
    if (deferredEnduranceUpdate.value?.team_num === update.prevNum) {
      deferredEnduranceUpdate.value = { ...deferredEnduranceUpdate.value, team_num: update.team_num };
    }
    loadData();
    return;
  }
  const { team_num, field, value } = update;
  // 이 이벤트보다 먼저 시작한 전체 조회의 내구 스냅샷은 적용하지 않는다.
  enduranceFetchSeq++;
  if (focusedCell.value && focusedCell.value.num === team_num && focusedCell.value.field === field) {
    deferredEnduranceUpdate.value = update;
    return;
  }
  if (!endurance.value[team_num]) endurance.value[team_num] = {};
  endurance.value[team_num][field] = value;
  scheduleScoreRefresh();
});

watch(lastPenaltyUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, cone_penalty, oc_penalty, start_delay } = update;
  if (!penalties.value[event_type]) penalties.value[event_type] = {};
  penalties.value[event_type].cone_penalty = cone_penalty;
  penalties.value[event_type].oc_penalty = oc_penalty;
  penalties.value[event_type].start_delay = start_delay;
  scheduleScoreRefresh();
});

watch(lastSettingUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, setting_key, value } = update;
  if (!settings.value[event_type]) settings.value[event_type] = {};
  settings.value[event_type][setting_key] = value;
  scheduleScoreRefresh();
});

let scoreRefreshTimer = null;
function scheduleScoreRefresh() {
  // 직접 반영한 내구·설정 SSE보다 먼저 시작한 score 스냅샷을 즉시 무효화한다.
  scoreSnapshotSeq++;
  clearTimeout(scoreRefreshTimer);
  scoreRefreshTimer = setTimeout(refreshScoreData, 250);
}

async function refreshScoreData() {
  const year = selectedYear.value;
  const seq = ++scoreSnapshotSeq;
  try {
    const data = await fetchScore(year);
    if (seq !== scoreSnapshotSeq || selectedYear.value !== year) return;
    entries.value = data.entries || {};
    penalties.value = data.penalties || {};
    settings.value = data.settings || {};
    energy.value = data.energy || { teams: {}, config: {}, references: {} };
  } catch {
    if (seq === scoreSnapshotSeq && selectedYear.value === year) error("에너지 점수를 다시 계산할 수 없습니다.");
  }
}

onUnmounted(() => clearTimeout(scoreRefreshTimer));

// Deferred SSE recovery
function applyDeferredCell(prevCell) {
  const deferred = deferredEnduranceUpdate.value;
  if (deferred && deferred.team_num === prevCell.num && deferred.field === prevCell.field && !cellEdited) {
    if (!endurance.value[deferred.team_num]) endurance.value[deferred.team_num] = {};
    endurance.value[deferred.team_num][deferred.field] = deferred.value;
  }
  deferredEnduranceUpdate.value = null;
  cellEdited = false;
}

function handleCellBlur() {
  const prev = focusedCell.value;
  // 확인 없이 포커스를 옮기면 편집 버퍼만 버리고 저장된 값을 다시 표시한다.
  editingValue.value = null;
  if (prev) applyDeferredCell(prev);
  focusedCell.value = null;
}

// 편집 중인 칸의 화면 값. Vue 3는 `value` prop만 특수 취급해서, 바인딩 결과가 그대로여도
// 리렌더링마다 DOM에 다시 쓴다(runtime-core patchProps: `if ("value" in newProps)` 무조건 호출
// → runtime-dom이 `el.value !== newValue`로 살아있는 DOM 값과 비교해 덮어씀). 그래서 경기 중
// SSE로 다른 팀 기록이 들어오기만 해도 운영자가 타이핑 중이던 값이 스토어 값으로 되돌아갔다.
// 실패도 에러도 아니라 입력이 조용히 사라졌다.
//
// focusedCell의 defer 가드로는 못 막는다. 그건 같은 칸의 업데이트만 미루는데, 리렌더링은
// 같은 행의 다른 필드·다른 팀·재조회 등 어디서든 발생하기 때문이다.
const editingValue = ref(null);

function isEditing(num, field) {
  return focusedCell.value?.num === num && focusedCell.value?.field === field;
}

// 포커스된 칸만 스토어 대신 편집 버퍼를 쓴다. 나머지는 종전대로 스토어를 따른다.
function displayValue(num, field, stored) {
  return isEditing(num, field) && editingValue.value !== null ? editingValue.value : stored;
}

function handleCellInput(num, field, event) {
  if (isEditing(num, field)) editingValue.value = event.target.value;
}

function handleCellFocus(num, field, event) {
  focusedCell.value = { num, field };
  editingValue.value = event.target.value;
  cellEdited = false;
  event.target.select();
}

function handleConfigFocus(event) {
  configEditing.value = true;
  configEditingValue.value = event.target.value;
  event.target.select();
}

function handleConfigInput(event) {
  if (configEditing.value) configEditingValue.value = event.target.value;
}

function cancelConfigEdit() {
  configEditing.value = false;
  configEditingValue.value = null;
}

// Safety net watcher
watch(focusedCell, (newVal, oldVal) => {
  if (newVal !== null || !oldVal) return;
  applyDeferredCell(oldVal);
});

// SSE 재연결 시 전체 데이터 동기화
watch(reconnected, () => {
  if (!reconnected.value) return;
  deferredEnduranceUpdate.value = null;
  cellEdited = false;
  loadData();
});

// 계산 헬퍼
function getDrivingTime(num) {
  const d = endurance.value[num];
  if (!d || d.driver1_time == null || d.driver2_time == null) return null;
  return d.driver1_time + d.driver2_time + (d.driver_change_time || 0);
}

function getPenaltyTime(num) {
  const d = endurance.value[num];
  if (!d) return null;
  const pen = penalties.value["내구"] || {};
  const startDelayMs = ((d.driver1_start_delay || 0) + (d.driver2_start_delay || 0)) * (pen.start_delay || 0) * 1000;
  const manualPenaltyMs = ((d.driver1_penalty || 0) + (d.driver2_penalty || 0)) * 1000;
  const cones = (d.driver1_cones || 0) + (d.driver2_cones || 0);
  const oc = (d.driver1_oc || 0) + (d.driver2_oc || 0);
  const conePenaltyMs = cones * (pen.cone_penalty || 0) * 1000;
  const ocPenaltyMs = oc * (pen.oc_penalty || 0) * 1000;
  const total = startDelayMs + manualPenaltyMs + conePenaltyMs + ocPenaltyMs;
  return total > 0 ? total : null;
}

function getFinalTime(num) {
  const s = getStatus(num);
  if (s) return null;
  const driving = getDrivingTime(num);
  if (driving == null) return null;
  return driving + (getPenaltyTime(num) || 0);
}

// 필드 헬퍼
function getField(num, field) {
  return endurance.value[num]?.[field] ?? null;
}

function getStatus(num) {
  return endurance.value[num]?.status || null;
}

function getEnergyType(entry) {
  if (entry?.type === "C-Formula") return "C";
  if (entry?.type === "E-Formula") return "E";
  return null;
}

function getEnergyResult(num) {
  return energy.value.teams?.[num] || null;
}

function getEnergySetting(key) {
  return settings.value["에너지"]?.[key] ?? null;
}

function getTypeColor(type) {
  return typeColorMap.value[type] || "blue";
}

function getFuelUnit() {
  const factor = Number(getEnergySetting("fuel_factor"));
  if (factor === 2.95) return "kg";
  if (factor === 2.31) return "L";
  return "L/kg";
}

function energyResultLabel(num) {
  const result = getEnergyResult(num);
  if (!result) return "대기";
  if (result.status === "DSQ") return "DSQ";
  if (result.status === "SCORED") return "정상";
  return result.reason || "대기";
}

async function saveEnergySetting(key, rawValue) {
  if (isReadOnly.value) return false;
  const value = rawValue === "" ? null : Number(rawValue);
  if (value !== null && (!Number.isFinite(value) || value <= 0)) {
    error("설정 값은 0보다 커야 합니다.");
    return false;
  }
  const oldValue = getEnergySetting(key);
  if (oldValue === value) return true;
  if (!settings.value["에너지"]) settings.value["에너지"] = {};
  settings.value["에너지"][key] = value;
  try {
    await updateSetting(selectedYear.value, "에너지", key, value);
    scheduleScoreRefresh();
    return true;
  } catch {
    settings.value["에너지"][key] = oldValue;
    error("에너지 설정 저장에 실패했습니다.");
    return false;
  }
}

async function confirmEnergySetting(input) {
  const saved = await saveEnergySetting("distance_km", configEditingValue.value ?? "");
  if (!configEditing.value) return;
  if (saved) input?.blur();
  else input?.select();
}

function isDisabled(num) {
  return isReadOnly.value || getStatus(num) === "DNS" || getStatus(num) === "DNF" || getStatus(num) === "DSQ";
}

function formatResult(ms) {
  if (ms == null) return "";
  const raw = Math.abs(Number(ms));
  if (isNaN(raw)) return "";
  const totalRounded = Math.round(raw);
  const millis = String(totalRounded % 1000).padStart(3, "0");
  const secs = Math.floor(totalRounded / 1000) % 60;
  const mins = Math.floor(totalRounded / 60000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${millis}`;
}

function parseTimeInput(str) {
  if (!str || !str.trim()) return null;
  str = str.trim();

  // 콜론 있음: M+:S{1,2}.m{1,3}
  const withColon = str.match(/^(\d+):(\d{1,2})\.(\d{1,3})$/);
  if (withColon) {
    const sec = Number(withColon[2]);
    if (sec >= 60) return undefined;
    return Number(withColon[1]) * 60000 + sec * 1000 + Number(withColon[3].padEnd(3, "0"));
  }

  // 콜론 없음: digits.m{1,3} → 끝 2자리=초, 나머지=분
  const noColon = str.match(/^(\d+)\.(\d{1,3})$/);
  if (!noColon) return undefined;
  const intPart = noColon[1];
  const millis = Number(noColon[2].padEnd(3, "0"));
  let minutes, seconds;
  if (intPart.length <= 2) {
    minutes = 0;
    seconds = Number(intPart);
  } else {
    seconds = Number(intPart.slice(-2));
    minutes = Number(intPart.slice(0, -2));
  }
  if (seconds >= 60) return undefined;
  return minutes * 60000 + seconds * 1000 + millis;
}

// 상태 토글
async function toggleStatus(num, status) {
  if (isReadOnly.value) return;
  const current = getStatus(num);
  const newValue = current === status ? null : status;

  if (!endurance.value[num]) endurance.value[num] = {};
  endurance.value[num].status = newValue;

  try {
    await updateEndurance(selectedYear.value, num, "status", newValue);
    scheduleScoreRefresh();
  } catch {
    endurance.value[num].status = current;
    error("저장에 실패했습니다.");
  }
}

// 시간 필드 저장
async function saveTimeField(num, field, input) {
  const rawValue = editingValue.value ?? input?.value ?? "";
  const parsed = parseTimeInput(rawValue);
  if (parsed === undefined) {
    input?.select();
    error("시간 형식: M:SS.mmm");
    return;
  }

  const oldValue = getField(num, field);
  if (parsed === oldValue) {
    input?.blur();
    return;
  }
  cellEdited = true;

  if (!endurance.value[num]) endurance.value[num] = {};
  endurance.value[num][field] = parsed;

  try {
    await updateEndurance(selectedYear.value, num, field, parsed);
    scheduleScoreRefresh();
    if (isEditing(num, field)) input?.blur();
  } catch {
    endurance.value[num][field] = oldValue;
    cellEdited = false;
    error("저장에 실패했습니다.");
    if (isEditing(num, field)) input?.select();
  }
}

// 드라이버 이름 저장
async function saveNameField(num, field, input) {
  const newValue = String(editingValue.value ?? input?.value ?? "").trim() || null;
  if (newValue && newValue.length > 100) {
    error("드라이버 이름은 100자 이하여야 합니다.");
    input?.select();
    return;
  }

  const oldValue = getField(num, field);
  if (newValue === oldValue) {
    input?.blur();
    return;
  }
  cellEdited = true;

  if (!endurance.value[num]) endurance.value[num] = {};
  endurance.value[num][field] = newValue;

  try {
    await updateEndurance(selectedYear.value, num, field, newValue);
    if (isEditing(num, field)) input?.blur();
  } catch {
    endurance.value[num][field] = oldValue;
    cellEdited = false;
    error("저장에 실패했습니다.");
    if (isEditing(num, field)) input?.select();
  }
}

// 숫자 필드 저장
async function saveNumField(num, field, input, isInteger = false, allowNegative = false) {
  const rawValue = String(editingValue.value ?? input?.value ?? "").trim();
  let newValue = rawValue === "" ? null : Number(rawValue);
  if (newValue !== null && (isNaN(newValue) || (!allowNegative && newValue < 0) || (isInteger && !Number.isInteger(newValue)))) {
    error(isInteger ? "0 이상의 정수를 입력하세요." : "올바른 숫자를 입력하세요.");
    input?.select();
    return;
  }

  const oldValue = getField(num, field);
  if (newValue === oldValue) {
    input?.blur();
    return;
  }
  cellEdited = true;

  if (!endurance.value[num]) endurance.value[num] = {};
  endurance.value[num][field] = newValue;

  try {
    await updateEndurance(selectedYear.value, num, field, newValue);
    scheduleScoreRefresh();
    if (isEditing(num, field)) input?.blur();
  } catch {
    endurance.value[num][field] = oldValue;
    cellEdited = false;
    error("저장에 실패했습니다.");
    if (isEditing(num, field)) input?.select();
  }
}

async function saveDirectField(num, field, value) {
  const normalized = value === "" ? null : value;
  const oldValue = getField(num, field);
  if (normalized === oldValue) return;
  if (!endurance.value[num]) endurance.value[num] = {};
  endurance.value[num][field] = normalized;
  try {
    await updateEndurance(selectedYear.value, num, field, normalized);
    scheduleScoreRefresh();
  } catch {
    endurance.value[num][field] = oldValue;
    error("저장에 실패했습니다.");
  }
}

async function toggleEnergyDsq(num) {
  if (isReadOnly.value) return;
  await saveDirectField(num, "energy_dsq", getField(num, "energy_dsq") ? 0 : 1);
}

async function toggleQualified(num, qualified) {
  if (isReadOnly.value) return;
  await saveDirectField(num, "qualified", qualified ? 1 : 0);
}

// 키보드 네비게이션 (Enter 저장은 ConfirmableInput이 처리)
function handleKeyNav(e) {
  const target = e.target;
  if (target.tagName !== "INPUT" || !target.classList.contains("cell-input") || target.disabled) return;

  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;

  // 좌우: 선택 없는 커서가 맨 앞/맨 끝일 때만 셀 이동 (number 입력은 항상 이동)
  const noSelection = target.selectionStart === target.selectionEnd;
  if (e.key === "ArrowLeft" && target.type !== "number" && !(noSelection && target.selectionStart === 0)) return;
  if (e.key === "ArrowRight" && target.type !== "number" && !(noSelection && target.selectionEnd === target.value.length)) return;

  e.preventDefault();

  const grid = getInputGrid(target);
  let row = -1, col = -1;
  for (let r = 0; r < grid.length; r++) {
    const c = grid[r].indexOf(target);
    if (c !== -1) { row = r; col = c; break; }
  }
  if (row === -1) return;

  let next = null;
  if (e.key === "ArrowLeft" && col > 0) next = grid[row][col - 1];
  else if (e.key === "ArrowRight" && col < grid[row].length - 1) next = grid[row][col + 1];
  else if (e.key === "ArrowUp") {
    for (let r = row - 1; r >= 0; r--) { if (grid[r][col]) { next = grid[r][col]; break; } }
  } else if (e.key === "ArrowDown") {
    for (let r = row + 1; r < grid.length; r++) { if (grid[r][col]) { next = grid[r][col]; break; } }
  }
  if (next) { next.focus(); next.select(); }
}

function getInputGrid(el) {
  const table = el.closest(".endurance-table");
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  return rows.map(tr => Array.from(tr.querySelectorAll("input.cell-input:not([disabled])")));
}

function exportData(format) {
  const headers = ["번호", "학교", "팀", "최종 기록", "주행시간", "페널티", "D1 이름", "D1 기록", "D1 출발지연", "D1 콘터치", "D1 코스이탈", "D1 페널티(초)", "교체 초과시간", "D2 이름", "D2 기록", "D2 출발지연", "D2 콘터치", "D2 코스이탈", "D2 페널티(초)", "상태", `연료 소비량(${getFuelUnit()})`, `추가 주유량(${getFuelUnit()})`, "순사용 전력량(kWh)", "보정 CO₂/100 km", "실격", "에너지 판정", "에너지 점수", "내구 진출"];
  const rows = entryList.value.map((entry) => {
    const num = entry.num;
    const ft = getFinalTime(num);
    const dt = getDrivingTime(num);
    const pt = getPenaltyTime(num);
    return [
      num, entry.univ || "", entry.team || "",
      getStatus(num) || (ft != null ? formatResult(ft) : ""),
      dt != null ? formatResult(dt) : "",
      pt ? formatResult(pt) : "",
      getField(num, "driver1_name") || "",
      formatResult(getField(num, "driver1_time")) || "",
      getField(num, "driver1_start_delay") ?? "",
      getField(num, "driver1_cones") ?? "",
      getField(num, "driver1_oc") ?? "",
      getField(num, "driver1_penalty") ?? "",
      formatResult(getField(num, "driver_change_time")) || "",
      getField(num, "driver2_name") || "",
      formatResult(getField(num, "driver2_time")) || "",
      getField(num, "driver2_start_delay") ?? "",
      getField(num, "driver2_cones") ?? "",
      getField(num, "driver2_oc") ?? "",
      getField(num, "driver2_penalty") ?? "",
      getStatus(num) || "",
      getEnergyType(entry) === "C" ? (getField(num, "fuel_consumed") ?? "") : "",
      getEnergyType(entry) === "C" ? (getField(num, "fuel_extra") ?? "") : "",
      getEnergyType(entry) === "E" ? (getField(num, "electric_net_energy") ?? "") : "",
      getEnergyResult(num)?.co2Per100Km ?? "",
      getField(num, "energy_dsq") ? "실격" : "",
      energyResultLabel(num),
      getEnergyResult(num)?.score ?? "",
      getField(num, "qualified") ? "진출" : "",
    ];
  });
  exportTable({ sheetName: "내구 기록", fileBase: `내구기록_${selectedYear.value}`, headers, rows, format });
}
</script>

<template>
  <div class="endurance-page">
    <div class="top-row">
      <div class="filter-bar">
        <div class="filter-group">
          <label class="filter-label">엔트리</label>
          <select class="filter-input" v-model.number="selectedYear" @change="onYearChange">
            <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
          </select>
        </div>
        <div class="filter-group energy-config-group">
          <label class="filter-label">내구 거리 (<span class="unit-symbol">km</span>)</label>
          <ConfirmableInput
            variant="filter"
            input-class="config-input"
            type="number"
            min="0"
            step="any"
            :value="configEditing ? (configEditingValue ?? '') : (getEnergySetting('distance_km') ?? '')"
            :editing="configEditing"
            :disabled="isReadOnly"
            placeholder="예: 20"
            confirm-label="내구 거리 입력 확인"
            @input="handleConfigInput"
            @focus="handleConfigFocus"
            @blur="cancelConfigEdit"
            @confirm="confirmEnergySetting"
          />
        </div>
        <div class="filter-group energy-config-group">
          <label class="filter-label">휘발유 기준</label>
          <select class="filter-input" :value="getEnergySetting('fuel_factor') ?? ''" :disabled="isReadOnly" @change="saveEnergySetting('fuel_factor', $event.target.value)">
            <option value="" disabled>선택</option>
            <option :value="2.31">부피 (L)</option>
            <option :value="2.95">질량 (kg)</option>
          </select>
        </div>
        <div class="filter-group">
          <label class="filter-label">검색</label>
          <input class="filter-input" v-model="searchQuery" placeholder="번호 / 학교 / 팀명" />
        </div>
        <div v-if="vehicleTypes.length > 1" class="filter-group type-filter-gap">
          <label class="filter-label">유형</label>
          <div class="type-filter-group">
            <label v-for="type in vehicleTypes" :key="type" class="filter-checkbox">
              <input v-model="typeFilters[type]" type="checkbox" />
              <span class="badge" :class="'badge-type-' + getTypeColor(type)">{{ type }}</span>
            </label>
          </div>
        </div>
        <div class="filter-group type-filter-gap">
          <label class="filter-label">필터</label>
          <label class="filter-checkbox">
            <input v-model="showQualifiedOnly" type="checkbox" />
            <span>내구 진출팀</span>
          </label>
        </div>
        <div class="filter-group action-group">
          <label class="filter-label">&nbsp;</label>
          <div class="action-buttons">
            <button class="action-link" @click="exportData('csv')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>CSV</button>
            <button class="action-link" @click="exportData('xlsx')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>XLSX</button>
            <router-link to="/" class="action-link nav-link">성적표</router-link>
          </div>
        </div>
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <div class="card table-card">
      <div class="card-header">
        <div class="header-left">
          <h3>내구 기록 입력</h3>
          <span class="count-badge">{{ entryList.length }}개 팀</span>
        </div>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="sticky-host">
          <div ref="headBandRef" class="head-band"></div>
          <div ref="headScrollerRef" class="table-container">
          <table ref="tableRef" class="data-table endurance-table" :data-sticky-cols="stickyCols" @keydown="handleKeyNav">
            <thead>
              <tr>
                <th class="col-num" rowspan="2">번호</th>
                <th class="col-team" rowspan="2">학교 / 팀</th>
                <th class="col-summary" rowspan="2">최종 기록</th>
                <th class="col-summary" rowspan="2">주행시간</th>
                <th class="col-summary" rowspan="2">페널티</th>
                <th class="col-driver-group" colspan="6">드라이버 1</th>
                <th class="col-change" rowspan="2">교체<br>초과시간</th>
                <th class="col-driver-group" colspan="6">드라이버 2</th>
                <th class="col-status" rowspan="2">상태</th>
                <th class="col-energy-group" colspan="7">에너지 효율</th>
                <th class="col-qualified" rowspan="2">내구<br>진출</th>
              </tr>
              <tr>
                <th class="col-field">이름</th>
                <th class="col-field">기록</th>
                <th class="col-field">출발지연</th>
                <th class="col-field">콘터치</th>
                <th class="col-field">코스이탈</th>
                <th class="col-field">페널티(초)</th>
                <th class="col-field">이름</th>
                <th class="col-field">기록</th>
                <th class="col-field">출발지연</th>
                <th class="col-field">콘터치</th>
                <th class="col-field">코스이탈</th>
                <th class="col-field">페널티(초)</th>
                <th class="col-energy">연료 소비<br>(<span class="unit-symbol">{{ getFuelUnit() }}</span>)</th>
                <th class="col-energy">추가 주유<br>(<span class="unit-symbol">{{ getFuelUnit() }}</span>)</th>
                <th class="col-energy">순사용 전력<br>(<span class="unit-symbol">kWh</span>)</th>
                <th class="col-energy">보정 CO₂<br>/100 <span class="unit-symbol">km</span></th>
                <th class="col-energy-official">실격</th>
                <th class="col-energy">판정</th>
                <th class="col-energy">점수</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entryList" :key="entry.num" :class="{ 'row-disabled': isDisabled(entry.num) }">
                <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                <td class="col-summary">
                  <span v-if="getStatus(entry.num)" class="record-value" :class="getStatus(entry.num).toLowerCase()">{{ getStatus(entry.num) }}</span>
                  <span v-else-if="getFinalTime(entry.num) != null" class="record-value">{{ formatResult(getFinalTime(entry.num)) }}</span>
                  <span v-else class="cell-display">-</span>
                </td>
                <td class="col-summary">
                  <span v-if="getDrivingTime(entry.num) != null" class="cell-display time-display">{{ formatResult(getDrivingTime(entry.num)) }}</span>
                  <span v-else class="cell-display">-</span>
                </td>
                <td class="col-summary">
                  <span v-if="getPenaltyTime(entry.num)" class="penalty-display">+{{ formatResult(getPenaltyTime(entry.num)) }}</span>
                  <span v-else class="cell-display">-</span>
                </td>
                <!-- Driver 1 -->
                <td class="col-field"><ConfirmableInput input-class="name-input" maxlength="100" :value="displayValue(entry.num, 'driver1_name', getField(entry.num, 'driver1_name') ?? '')" :editing="isEditing(entry.num, 'driver1_name')" :disabled="isDisabled(entry.num)" placeholder="이름" confirm-label="드라이버 1 이름 입력 확인" @input="handleCellInput(entry.num, 'driver1_name', $event)" @focus="handleCellFocus(entry.num, 'driver1_name', $event)" @blur="handleCellBlur" @confirm="saveNameField(entry.num, 'driver1_name', $event)" /></td>
                <td class="col-field"><ConfirmableInput input-class="time-input" :value="displayValue(entry.num, 'driver1_time', formatResult(getField(entry.num, 'driver1_time')))" :editing="isEditing(entry.num, 'driver1_time')" :disabled="isDisabled(entry.num)" placeholder="0:00.000" confirm-label="드라이버 1 기록 입력 확인" @input="handleCellInput(entry.num, 'driver1_time', $event)" @focus="handleCellFocus(entry.num, 'driver1_time', $event)" @blur="handleCellBlur" @confirm="saveTimeField(entry.num, 'driver1_time', $event)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver1_start_delay', getField(entry.num, 'driver1_start_delay') ?? '')" :editing="isEditing(entry.num, 'driver1_start_delay')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 1 출발지연 입력 확인" @input="handleCellInput(entry.num, 'driver1_start_delay', $event)" @focus="handleCellFocus(entry.num, 'driver1_start_delay', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver1_start_delay', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver1_cones', getField(entry.num, 'driver1_cones') ?? '')" :editing="isEditing(entry.num, 'driver1_cones')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 1 콘터치 입력 확인" @input="handleCellInput(entry.num, 'driver1_cones', $event)" @focus="handleCellFocus(entry.num, 'driver1_cones', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver1_cones', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver1_oc', getField(entry.num, 'driver1_oc') ?? '')" :editing="isEditing(entry.num, 'driver1_oc')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 1 코스이탈 입력 확인" @input="handleCellInput(entry.num, 'driver1_oc', $event)" @focus="handleCellFocus(entry.num, 'driver1_oc', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver1_oc', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="any" :value="displayValue(entry.num, 'driver1_penalty', getField(entry.num, 'driver1_penalty') ?? '')" :editing="isEditing(entry.num, 'driver1_penalty')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 1 페널티 입력 확인" @input="handleCellInput(entry.num, 'driver1_penalty', $event)" @focus="handleCellFocus(entry.num, 'driver1_penalty', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver1_penalty', $event)" /></td>
                <!-- Driver change -->
                <td class="col-change"><ConfirmableInput input-class="time-input" :value="displayValue(entry.num, 'driver_change_time', formatResult(getField(entry.num, 'driver_change_time')))" :editing="isEditing(entry.num, 'driver_change_time')" :disabled="isDisabled(entry.num)" placeholder="0:00.000" confirm-label="교체 초과시간 입력 확인" @input="handleCellInput(entry.num, 'driver_change_time', $event)" @focus="handleCellFocus(entry.num, 'driver_change_time', $event)" @blur="handleCellBlur" @confirm="saveTimeField(entry.num, 'driver_change_time', $event)" /></td>
                <!-- Driver 2 -->
                <td class="col-field"><ConfirmableInput input-class="name-input" maxlength="100" :value="displayValue(entry.num, 'driver2_name', getField(entry.num, 'driver2_name') ?? '')" :editing="isEditing(entry.num, 'driver2_name')" :disabled="isDisabled(entry.num)" placeholder="이름" confirm-label="드라이버 2 이름 입력 확인" @input="handleCellInput(entry.num, 'driver2_name', $event)" @focus="handleCellFocus(entry.num, 'driver2_name', $event)" @blur="handleCellBlur" @confirm="saveNameField(entry.num, 'driver2_name', $event)" /></td>
                <td class="col-field"><ConfirmableInput input-class="time-input" :value="displayValue(entry.num, 'driver2_time', formatResult(getField(entry.num, 'driver2_time')))" :editing="isEditing(entry.num, 'driver2_time')" :disabled="isDisabled(entry.num)" placeholder="0:00.000" confirm-label="드라이버 2 기록 입력 확인" @input="handleCellInput(entry.num, 'driver2_time', $event)" @focus="handleCellFocus(entry.num, 'driver2_time', $event)" @blur="handleCellBlur" @confirm="saveTimeField(entry.num, 'driver2_time', $event)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver2_start_delay', getField(entry.num, 'driver2_start_delay') ?? '')" :editing="isEditing(entry.num, 'driver2_start_delay')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 2 출발지연 입력 확인" @input="handleCellInput(entry.num, 'driver2_start_delay', $event)" @focus="handleCellFocus(entry.num, 'driver2_start_delay', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver2_start_delay', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver2_cones', getField(entry.num, 'driver2_cones') ?? '')" :editing="isEditing(entry.num, 'driver2_cones')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 2 콘터치 입력 확인" @input="handleCellInput(entry.num, 'driver2_cones', $event)" @focus="handleCellFocus(entry.num, 'driver2_cones', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver2_cones', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="1" :value="displayValue(entry.num, 'driver2_oc', getField(entry.num, 'driver2_oc') ?? '')" :editing="isEditing(entry.num, 'driver2_oc')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 2 코스이탈 입력 확인" @input="handleCellInput(entry.num, 'driver2_oc', $event)" @focus="handleCellFocus(entry.num, 'driver2_oc', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver2_oc', $event, true)" /></td>
                <td class="col-field"><ConfirmableInput input-class="num-input" type="number" min="0" step="any" :value="displayValue(entry.num, 'driver2_penalty', getField(entry.num, 'driver2_penalty') ?? '')" :editing="isEditing(entry.num, 'driver2_penalty')" :disabled="isDisabled(entry.num)" placeholder="-" confirm-label="드라이버 2 페널티 입력 확인" @input="handleCellInput(entry.num, 'driver2_penalty', $event)" @focus="handleCellFocus(entry.num, 'driver2_penalty', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'driver2_penalty', $event)" /></td>
                <td class="col-status">
                  <div class="status-group">
                    <button
                      v-for="s in ['DNS', 'DNF', 'DSQ']"
                      :key="s"
                      class="status-btn" tabindex="-1"
                      :class="{ active: getStatus(entry.num) === s, [`status-${s.toLowerCase()}`]: getStatus(entry.num) === s }"
                      :disabled="isReadOnly"
                      @click="toggleStatus(entry.num, s)"
                    >{{ s }}</button>
                  </div>
                </td>
                <td class="col-energy"><ConfirmableInput input-class="energy-input" field="fuel_consumed" type="number" min="0" step="any" :value="displayValue(entry.num, 'fuel_consumed', getEnergyType(entry) === 'C' ? (getField(entry.num, 'fuel_consumed') ?? '') : '')" :editing="isEditing(entry.num, 'fuel_consumed')" :disabled="isDisabled(entry.num) || getEnergyType(entry) !== 'C'" :placeholder="getEnergyType(entry) === 'C' ? '-' : ''" confirm-label="연료 소비량 입력 확인" @input="handleCellInput(entry.num, 'fuel_consumed', $event)" @focus="handleCellFocus(entry.num, 'fuel_consumed', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'fuel_consumed', $event)" /></td>
                <td class="col-energy"><ConfirmableInput input-class="energy-input" field="fuel_extra" type="number" min="0" step="any" :value="displayValue(entry.num, 'fuel_extra', getEnergyType(entry) === 'C' ? (getField(entry.num, 'fuel_extra') ?? '') : '')" :editing="isEditing(entry.num, 'fuel_extra')" :disabled="isDisabled(entry.num) || getEnergyType(entry) !== 'C'" :placeholder="getEnergyType(entry) === 'C' ? '-' : ''" confirm-label="추가 주유량 입력 확인" @input="handleCellInput(entry.num, 'fuel_extra', $event)" @focus="handleCellFocus(entry.num, 'fuel_extra', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'fuel_extra', $event)" /></td>
                <td class="col-energy"><ConfirmableInput input-class="energy-input" field="electric_net_energy" type="number" step="any" :value="displayValue(entry.num, 'electric_net_energy', getEnergyType(entry) === 'E' ? (getField(entry.num, 'electric_net_energy') ?? '') : '')" :editing="isEditing(entry.num, 'electric_net_energy')" :disabled="isDisabled(entry.num) || getEnergyType(entry) !== 'E'" :placeholder="getEnergyType(entry) === 'E' ? '-' : ''" confirm-label="순사용 전력량 입력 확인" @input="handleCellInput(entry.num, 'electric_net_energy', $event)" @focus="handleCellFocus(entry.num, 'electric_net_energy', $event)" @blur="handleCellBlur" @confirm="saveNumField(entry.num, 'electric_net_energy', $event, false, true)" /></td>
                <td class="col-energy"><span class="energy-metric">{{ getEnergyResult(entry.num)?.co2Per100Km ?? '-' }}</span></td>
                <td class="col-energy-official">
                  <button class="energy-dsq-btn" :class="{ active: !!getField(entry.num, 'energy_dsq') }" :disabled="isReadOnly" @click="toggleEnergyDsq(entry.num)">DSQ</button>
                </td>
                <td class="col-energy"><span class="energy-status" :class="'energy-status-' + (getEnergyResult(entry.num)?.status || 'PENDING').toLowerCase()" :title="getEnergyResult(entry.num)?.reason || ''">{{ energyResultLabel(entry.num) }}</span></td>
                <td class="col-energy"><span class="energy-score" :title="getEnergyResult(entry.num)?.reason || ''">{{ getEnergyResult(entry.num)?.score ?? (getEnergyResult(entry.num)?.status === 'PENDING' ? '대기' : '-') }}</span></td>
                <td class="col-qualified">
                  <label class="qualification-switch">
                    <input
                      class="qualified-toggle"
                      type="checkbox"
                      :checked="!!getField(entry.num, 'qualified')"
                      :disabled="isReadOnly"
                      :aria-label="`${entry.num}번 내구 진출 여부`"
                      @change="toggleQualified(entry.num, $event.target.checked)"
                    />
                    <span class="qualification-slider" aria-hidden="true"></span>
                  </label>
                </td>
              </tr>
              <tr v-if="entryList.length === 0">
                <td colspan="27" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
          <StickyFreezeLine :line-x="lineX" :active="stickyCols > 1" @pointerdown="startDrag" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.endurance-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.top-row {
  display: flex;
  gap: 1rem;
  align-items: stretch;
}

.top-row > .filter-bar {
  flex: 1;
  min-width: 0;
  align-items: center;
  align-content: center;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  align-items: flex-end;
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

.unit-symbol {
  text-transform: none;
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

.type-filter-gap {
  margin-left: 1rem;
}

.type-filter-group {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  height: 2.125rem;
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

.action-group {
  margin-left: auto;
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  height: 2.125rem;
}

.action-link {
  display: inline-flex;
  align-items: center;
  padding: 0 0.75rem;
  height: 100%;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-link:hover {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
}

.nav-link {
  width: 5.5rem;
  justify-content: center;
}

.action-icon {
  width: 14px;
  height: 14px;
  margin-right: 0.25rem;
  flex-shrink: 0;
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

/* .table-card / .head-band 는 세 표가 공유하므로 main.css 에 있다. */

.endurance-table {
  min-width: 2160px;
}

.endurance-table th {
  white-space: nowrap;
  font-size: 0.875rem;
  /* border-collapse 테두리는 떠 있는 헤더에 안 남는다. 그림자로 대신 그린다 */
  border-bottom: 0;
  box-shadow: inset 0 -1px 0 var(--border-color);
}

/* 헤더가 행 위에 떠 있어 반투명하면 행이 비친다. 틴트가 걸린 열만 불투명 배경 위에
   다시 얹는다. 나머지 헤더 셀은 .data-table th 가 이미 불투명하게 칠한다. */
.endurance-table thead .col-summary {
  background-color: var(--bg-secondary);
  background-image: linear-gradient(rgba(94, 106, 210, 0.04), rgba(94, 106, 210, 0.04));
}

.endurance-table thead .col-energy {
  background-color: var(--bg-secondary);
  background-image: linear-gradient(rgba(16, 185, 129, 0.035), rgba(16, 185, 129, 0.035));
}

/* 그룹 헤더는 아랫줄과의 2px 구분선도 border 가 아니라 그림자로 그린다 */
.endurance-table thead .col-driver-group {
  box-shadow: inset 0 -2px 0 var(--border-color);
}

.endurance-table thead .col-energy-group {
  background-color: var(--bg-secondary);
  background-image: linear-gradient(rgba(16, 185, 129, 0.08), rgba(16, 185, 129, 0.08));
  box-shadow: inset 0 -2px 0 var(--border-color);
}

.col-num,
.col-team,
.col-status,
.col-summary,
.col-change,
.col-field {
  width: 1%;
  white-space: nowrap;
}

.col-energy,
.col-energy-official,
.col-qualified {
  width: 1%;
  white-space: nowrap;
  text-align: center !important;
}

.col-energy-group {
  text-align: center !important;
  border-bottom: 2px solid var(--border-color);
  background: rgba(16, 185, 129, 0.08);
}

.col-energy {
  background: rgba(16, 185, 129, 0.035);
}

.energy-dsq-btn {
  padding: 0.25rem 0.45rem;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
}

.energy-dsq-btn.active {
  background: #7c3aed;
  border-color: #7c3aed;
  color: white;
}

.energy-metric,
.energy-score {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
}

.energy-score {
  font-weight: 700;
  color: var(--accent-success);
}

.energy-status {
  display: inline-block;
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-tertiary);
  font-size: 0.7rem;
  font-weight: 700;
  cursor: help;
}

.energy-status-scored {
  background: rgba(16, 185, 129, 0.14);
  color: var(--accent-success);
}

.energy-status-dsq {
  background: rgba(239, 68, 68, 0.14);
  color: var(--accent-danger);
}

.col-num {
  text-align: center !important;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.endurance-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
}

.endurance-table[data-sticky-cols="2"] .col-team {
  position: sticky;
  left: var(--sticky-l1, 0);
  z-index: 1;
  background: var(--bg-card);
}

.endurance-table[data-sticky-cols="2"] thead .col-team {
  z-index: 3;
}

.col-team {
  font-size: 0.875rem;
}

.col-status,
.col-qualified,
.col-summary,
.col-change,
.col-field {
  text-align: center !important;
}

.col-summary {
  background: rgba(94, 106, 210, 0.04);
}

.record-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--accent-success);
}

.record-value.dnf,
.record-value.dsq {
  color: var(--accent-danger);
}

.record-value.dns { color: var(--text-tertiary); }

.cell-display {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
}

.time-display {
  color: var(--accent-success);
  font-weight: 700;
}

.penalty-display {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--accent-danger);
}

.col-driver-group {
  text-align: center !important;
  border-bottom: 2px solid var(--border-color);
}

/* Status buttons */
.status-group {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.status-btn {
  padding: 0.25rem 0.5rem;
  border: none;
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.status-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.status-btn + .status-btn {
  border-left: 1px solid var(--border-color);
}

.status-btn.active.status-dns {
  background: var(--accent-warning);
  color: white;
}

.status-btn.active.status-dnf {
  background: var(--accent-danger);
  color: white;
}

.status-btn.active.status-dsq {
  background: #7c3aed;
  color: white;
}

.qualification-switch {
  display: inline-block;
  position: relative;
  width: 2.5rem;
  height: 1.35rem;
}

.qualified-toggle {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.qualification-slider {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--border-color);
  cursor: pointer;
  transition: background 0.15s ease;
}

.qualification-slider::before {
  content: "";
  position: absolute;
  top: 0.175rem;
  left: 0.2rem;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease;
}

.qualified-toggle:checked + .qualification-slider {
  background: var(--accent-success);
}

.qualified-toggle:checked + .qualification-slider::before {
  transform: translateX(1.1rem);
}

.qualified-toggle:focus-visible + .qualification-slider {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.qualified-toggle:disabled + .qualification-slider {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .top-row {
    flex-direction: column;
  }

  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-group {
    width: 100%;
  }

  .filter-input {
    width: 100%;
    box-sizing: border-box;
  }
}
</style>
