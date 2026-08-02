<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { exportTable } from "../composables/exportTable";
import { fetchEntryYears, fetchScore, fetchScorePublication, fetchVehicleTypes, updateManualScore, updatePenalty, updateScorePublication, updateSetting } from "../api";
import { useNotification } from "@shared/useNotification.js";
import { useStickyColumns } from "@shared/useStickyColumns.js";
import { createKeyedDebouncer } from "@shared/debounce.js";
import StickyFreezeLine from "@shared/StickyFreezeLine.vue";
import { useSSE } from "../composables/useSSE";

const { error, success } = useNotification();
const { lastInspectionUpdate, lastAnswerUpdate, lastTrafficRecordUpdate, lastManualScoreUpdate, lastPenaltyUpdate, lastSettingUpdate, lastEnduranceUpdate, lastPublicationUpdate, reconnected } = useSSE();

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const loading = ref(true);
const publicationLoading = ref(false);
const publicEnabled = ref(false);
const searchQuery = ref("");
const showInspection = ref(localStorage.getItem("score-show-inspection") !== "false");
watch(showInspection, (v) => localStorage.setItem("score-show-inspection", v));
const expandedRows = ref(new Set());
const detailExpandedTeam = ref(null);
const detailSortMode = ref("time");
const hoveredEvtGroup = ref(null);
const displayMode = ref(localStorage.getItem("score-display-mode") || "record");
watch(displayMode, (v) => localStorage.setItem("score-display-mode", v));

const tableRef = ref(null);
const { stickyCols, lineX, startDrag } = useStickyColumns({
  storageKey: "score-board-sticky-cols",
  tableRef,
  columnSelectors: [".col-num", ".col-team", ".col-type"],
});

// 정렬 상태
const sortKey = ref(null);
const sortOrder = ref("asc");

// 성적 데이터
const entries = ref({});
const inspection = ref({ categories: [], teams: {} });
const events = ref([]); // [{ type, tables, records }]
const manualScores = ref({}); // { team_num: { report, bonus, deduction } }
const penalties = ref({}); // { event_type: { cone_penalty, oc_penalty } }
const settings = ref({}); // { event_type: { total, finish, cutoff } }
const energy = ref({ teams: {}, config: {}, references: {} });

const dynamicEvents = computed(() => events.value.filter((e) => e.type !== "내구"));
const enduranceEvent = computed(() => events.value.find((e) => e.type === "내구") || { type: "내구", records: {} });

const typeFilters = ref({});

const vehicleTypes = computed(() => {
  const types = new Set();
  for (const e of Object.values(entries.value)) {
    if (e.type) types.add(e.type);
  }
  return [...types].sort();
});

// 새 유형이 나타나면 기본 활성화
watch(vehicleTypes, (types) => {
  for (const t of types) {
    if (!(t in typeFilters.value)) typeFilters.value[t] = true;
  }
});

const editingSettingCell = ref(null); // "penalty:cone_penalty:가속" or "setting:total:내구"

const isReadOnly = computed(() => selectedYear.value < new Date().getFullYear());
const publicPageUrl = computed(() => `${import.meta.env.BASE_URL}public/${selectedYear.value}`);

const entryList = computed(() => {
  let list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  // 차량 유형 필터
  if (vehicleTypes.value.length > 0) {
    list = list.filter(e => !e.type || typeFilters.value[e.type] !== false);
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(e => String(e.num).includes(q) || (e.univ || "").toLowerCase().includes(q) || (e.team || "").toLowerCase().includes(q));
  }

  if (!sortKey.value) return list.sort((a, b) => a.num - b.num);

  return [...list].sort((a, b) => {
    let aVal, bVal;

    if (sortKey.value === "num") {
      aVal = a.num;
      bVal = b.num;
    } else if (sortKey.value === "team") {
      aVal = `${a.univ || ""} ${a.team || ""}`.toLowerCase();
      bVal = `${b.univ || ""} ${b.team || ""}`.toLowerCase();
    } else if (sortKey.value === "type") {
      aVal = (a.type || "").toLowerCase();
      bVal = (b.type || "").toLowerCase();
    } else if (sortKey.value === "cornerWeight") {
      aVal = getCurbWeight(a.num);
      bVal = getCurbWeight(b.num);
      aVal = aVal != null ? Number(aVal) : Infinity;
      bVal = bVal != null ? Number(bVal) : Infinity;
    } else if (sortKey.value === "totalScore") {
      aVal = getTotalScore(a.num);
      bVal = getTotalScore(b.num);
      return sortOrder.value === "asc" ? bVal - aVal : aVal - bVal;
    } else if (["report", "energy", "bonus", "deduction"].includes(sortKey.value)) {
      aVal = sortKey.value === "energy" ? (getEnergyScore(a.num) ?? Infinity) : (manualScores.value[a.num]?.[sortKey.value] ?? Infinity);
      bVal = sortKey.value === "energy" ? (getEnergyScore(b.num) ?? Infinity) : (manualScores.value[b.num]?.[sortKey.value] ?? Infinity);
    } else if (sortKey.value.startsWith("event:")) {
      const eventType = sortKey.value.slice(6);
      const evt = events.value.find(e => e.type === eventType);
      if (displayMode.value === "score") {
        aVal = getEventScore(eventType, a.num) ?? -Infinity;
        bVal = getEventScore(eventType, b.num) ?? -Infinity;
        // 점수 높은 순이 기본
        return sortOrder.value === "asc" ? bVal - aVal : aVal - bVal;
      }
      const aRec = evt?.records[a.num];
      const bRec = evt?.records[b.num];
      const aAdj = getAdjustedResult(eventType, aRec);
      const bAdj = getAdjustedResult(eventType, bRec);
      // DNF(-1)는 완주 기록 뒤·미기록(null) 앞으로 정렬돼야 한다. Infinity-1은 IEEE754에서
      // 그대로 Infinity라 DNF와 null이 동률이 됐다 — 유한 sentinel로 순서를 되살린다.
      aVal = aAdj == null ? Infinity : aAdj === -1 ? Number.MAX_SAFE_INTEGER : Number(aAdj);
      bVal = bAdj == null ? Infinity : bAdj === -1 ? Number.MAX_SAFE_INTEGER : Number(bAdj);
    } else {
      aVal = 0;
      bVal = 0;
    }

    if (aVal < bVal) return sortOrder.value === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder.value === "asc" ? 1 : -1;
    return 0;
  });
});

onMounted(async () => {
  try {
    const years = await fetchEntryYears();
    availableYears.value = years;
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
    await Promise.all([loadData(), loadTypeColors(), loadPublication()]);
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;

  document.addEventListener("click", handleOutsideClick);
});

onUnmounted(() => {
  document.removeEventListener("click", handleOutsideClick);
  clearTimeout(refreshTimer);
});

function handleOutsideClick(e) {
  if (expandedRows.value.size && !e.target.closest(".col-corner-weight")) {
    expandedRows.value.clear();
  }
}

async function loadTypeColors() {
  const year = selectedYear.value;
  try {
    const vtList = await fetchVehicleTypes(year);
    if (selectedYear.value !== year) return;
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
  } catch { /* 색상 로드 실패 시 기본값 사용 */ }
}

let scoreDataSeq = 0;
let refreshSeq = 0;
async function loadData() {
  const year = selectedYear.value;
  const seq = ++scoreDataSeq;
  try {
    const data = await fetchScore(year);
    if (seq !== scoreDataSeq || selectedYear.value !== year) return;
    entries.value = data.entries;
    inspection.value = data.inspection;
    events.value = data.events;
    manualScores.value = data.manualScores || {};
    penalties.value = data.penalties || {};
    settings.value = data.settings || {};
    energy.value = data.energy || { teams: {}, config: {}, references: {} };
    sortKey.value = null;
    sortOrder.value = "asc";
  } catch (e) {
    if (seq === scoreDataSeq && selectedYear.value === year) error("데이터를 가져올 수 없습니다.");
  }
}

async function onYearChange() {
  // 이전 연도의 SSE 재조회가 나중에 완료되어 새 연도 스냅샷을 덮지 않게 한다.
  refreshSeq++;
  loading.value = true;
  detailExpandedTeam.value = null;
  await Promise.all([loadData(), loadTypeColors(), loadPublication()]);
  loading.value = false;
}

let publicationSeq = 0;
async function loadPublication() {
  const year = selectedYear.value;
  const seq = ++publicationSeq;
  publicationLoading.value = true;
  try {
    const state = await fetchScorePublication(year);
    if (seq === publicationSeq && selectedYear.value === year) publicEnabled.value = !!state.enabled;
  } catch {
    if (seq === publicationSeq) publicEnabled.value = false;
    if (seq === publicationSeq) error("공개 상태를 가져올 수 없습니다.");
  } finally {
    if (seq === publicationSeq) publicationLoading.value = false;
  }
}

async function handlePublicationToggle(enabled) {
  const year = selectedYear.value;
  publicationLoading.value = true;
  try {
    const state = await updateScorePublication(year, enabled);
    if (selectedYear.value === year) publicEnabled.value = !!state.enabled;
    success(enabled ? `${year}년 성적표를 공개했습니다.` : `${year}년 성적표 공개를 중지했습니다.`);
  } catch {
    error("공개 상태를 변경할 수 없습니다.");
  } finally {
    publicationLoading.value = false;
  }
}

// 검차 결과
function getInspectionResult(num, catId) {
  return inspection.value.teams[num]?.results?.[catId] || "";
}

// 검차 카테고리는 차량 유형별로 표시 여부가 정해진다(inspection 템플릿의 excluded_types).
// 열은 여러 유형이 섞인 표에서 공유하므로 해당하지 않는 팀의 칸만 비운다.
function categoryAppliesTo(cat, type) {
  if (!type) return true;
  return !(cat.excluded_types || []).includes(type);
}

// 경기 기록
function getTeamEvent(evt, num) {
  return evt.records[num] || null;
}

// 페널티 반영 기록 (ms)
function getAdjustedResult(eventType, rec) {
  if (!rec || rec.result == null || rec.result === -1) return rec?.result ?? null;
  const pen = penalties.value[eventType] || {};
  return rec.result + (rec.cones || 0) * (pen.cone_penalty || 0) * 1000 + (rec.oc || 0) * (pen.oc_penalty || 0) * 1000;
}

// 사전 계산된 점수 캐시 (events/penalties/settings 변경 시 자동 재계산)
const scoreCache = computed(() => {
  const bestAdjustedMap = {}; // eventType → best adjusted time
  const eventScoreMap = {}; // eventType → { num → score }
  const totalScoreMap = {}; // num → total score

  // 1. 종목별 최고 기록 산출
  for (const evt of events.value) {
    let best = null;
    for (const rec of Object.values(evt.records)) {
      const adj = getAdjustedResult(evt.type, rec);
      if (adj != null && adj >= 0 && (best === null || adj < best)) best = adj;
    }
    bestAdjustedMap[evt.type] = best;
  }

  // 2. 종목별 팀 점수 산출
  for (const evt of events.value) {
    const scores = {};
    const best = bestAdjustedMap[evt.type];
    const s = settings.value[evt.type] || {};
    const total = s.total ?? 0;
    const finish = s.finish ?? 0;
    const cutoff = (s.cutoff ?? 0) / 100;

    for (const [num, rec] of Object.entries(evt.records)) {
      const my = getAdjustedResult(evt.type, rec);
      if (my == null) { scores[num] = null; continue; }
      if (my === -1) { scores[num] = 0; continue; }
      if (my <= 0) { scores[num] = finish; continue; }
      if (best == null || best <= 0 || cutoff <= 1) { scores[num] = null; continue; }
      if (my > best * cutoff) { scores[num] = finish; continue; }
      const score = (total - finish) * ((cutoff * best / my) - 1) / (cutoff - 1) + finish;
      scores[num] = Math.max(finish, Math.min(total, parseFloat(score.toFixed(2))));
    }
    eventScoreMap[evt.type] = scores;
  }

  // 3. 총점 산출
  for (const num of Object.keys(entries.value)) {
    let t = 0;
    for (const evt of events.value) {
      const s = eventScoreMap[evt.type]?.[num];
      if (s != null) t += s;
    }
    t += manualScores.value[num]?.report ?? 0;
    t += getEnergyScore(num) ?? 0;
    t += manualScores.value[num]?.bonus ?? 0;
    t -= manualScores.value[num]?.deduction ?? 0;
    totalScoreMap[num] = parseFloat(t.toFixed(2));
  }

  return { bestAdjustedMap, eventScoreMap, totalScoreMap };
});

// 종목별 최고 페널티 반영 기록 (가장 빠른 팀)
function getBestAdjusted(eventType) {
  return scoreCache.value.bestAdjustedMap[eventType] ?? null;
}

// 점수 계산 (캐시에서 O(1) 조회)
function getEventScore(eventType, num) {
  return scoreCache.value.eventScoreMap[eventType]?.[num] ?? null;
}

// 총점 계산 (캐시에서 O(1) 조회)
function getTotalScore(num) {
  return scoreCache.value.totalScoreMap[num] ?? 0;
}

function getEnergyResult(num) {
  return energy.value.teams?.[num] || null;
}

function getEnergyScore(num) {
  const result = getEnergyResult(num);
  return result?.status === "SCORED" ? result.score : result?.status === "DSQ" ? 0 : null;
}

function getEnergyTitle(num) {
  const result = getEnergyResult(num);
  if (!result) return "에너지 계측값을 입력하세요.";
  if (result.reason) return result.reason;
  const details = [];
  if (result.co2Per100Km != null) details.push(`${result.co2Per100Km} kg CO₂/100km`);
  if (result.ef != null) details.push(`EF ${result.ef}`);
  return details.join(" · ") || "에너지 효율 점수";
}

const typeColorMap = ref({});
function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
}

function formatTime(time) {
  return new Date(time).toLocaleString("ko-KR");
}

function formatResult(result) {
  if (result === -1) return "DNF";
  if (result == null) return "-";
  const ms = Number(result);
  if (isNaN(ms)) return String(result);
  const totalRounded = Math.round(Math.abs(ms));
  const millis = String(totalRounded % 1000).padStart(3, "0");
  const secs = Math.floor(totalRounded / 1000) % 60;
  const mins = Math.floor(totalRounded / 60000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${millis}`;
}

// 수동 점수 저장
async function handleManualSave(teamNum, scoreType, value) {
  const numValue = value === "" ? null : Number(value);
  const oldValue = manualScores.value[teamNum]?.[scoreType] ?? null;
  if (numValue === oldValue) return;

  if (!manualScores.value[teamNum]) manualScores.value[teamNum] = {};
  manualScores.value[teamNum][scoreType] = numValue;

  try {
    await updateManualScore(selectedYear.value, teamNum, scoreType, numValue);
  } catch {
    manualScores.value[teamNum][scoreType] = oldValue;
    error("점수 저장에 실패했습니다.");
  }
}

function getManualScore(teamNum, scoreType) {
  return manualScores.value[teamNum]?.[scoreType] ?? null;
}

function isReportOverMax(teamNum) {
  const value = getManualScore(teamNum, "report");
  const maximum = getSetting("보고서", "total");
  return value != null && maximum != null && value > maximum;
}

// 페널티 설정 저장
async function handlePenaltySave(eventType, field, value) {
  editingSettingCell.value = null;
  const numValue = value === "" ? 0 : Number(value);
  if (isNaN(numValue) || numValue < 0) return;

  const current = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
  const oldValue = current[field] ?? 0;
  if (numValue === oldValue) return;

  if (!penalties.value[eventType]) penalties.value[eventType] = { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
  penalties.value[eventType][field] = numValue;

  try {
    const p = penalties.value[eventType];
    await updatePenalty(selectedYear.value, eventType, p.cone_penalty, p.oc_penalty, p.start_delay);
  } catch {
    penalties.value[eventType][field] = oldValue;
    error("페널티 설정 저장에 실패했습니다.");
  }
}

function getPenalty(eventType, field) {
  return penalties.value[eventType]?.[field] ?? 0;
}

function startSettingEdit(key) {
  if (isReadOnly.value) return;
  editingSettingCell.value = key;
}

function settingInputRef(el) {
  if (el) { el.focus(); el.select(); }
}

// 점수 설정 저장
async function handleSettingSave(eventType, key, value) {
  editingSettingCell.value = null;
  const numValue = value === "" ? null : Number(value);
  if (numValue !== null && isNaN(numValue)) return;

  const oldValue = settings.value[eventType]?.[key] ?? null;
  if (numValue === oldValue) return;

  if (!settings.value[eventType]) settings.value[eventType] = {};
  settings.value[eventType][key] = numValue;

  try {
    await updateSetting(selectedYear.value, eventType, key, numValue);
  } catch {
    settings.value[eventType][key] = oldValue;
    error("점수 설정 저장에 실패했습니다.");
  }
}

function getSetting(eventType, key) {
  return settings.value[eventType]?.[key] ?? null;
}

// 키보드 방향키 네비게이션 (내구 입력과 동일)
function handleKeyNav(e) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const target = e.target;
  if (target.tagName !== "INPUT" || target.disabled) return;
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
  const table = el.closest(".score-table");
  const rows = Array.from(table.querySelectorAll("tbody tr.team-row"));
  return rows.map((tr) => Array.from(tr.querySelectorAll("input:not([disabled])")));
}

// 정렬
function handleSort(key) {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
}

function getSortIcon(key) {
  if (sortKey.value !== key) return "↕";
  return sortOrder.value === "asc" ? "↑" : "↓";
}

// SSE로 검차 결과 실시간 반영
watch(lastInspectionUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete inspection.value.teams[update.team_num];
    debouncedRefresh();
    return;
  }
  if (update.renumbered) {
    if (inspection.value.teams[update.prevNum]) {
      inspection.value.teams[update.team_num] = inspection.value.teams[update.prevNum];
      delete inspection.value.teams[update.prevNum];
    }
    debouncedRefresh();
    return;
  }
  const { team_num, category_id, result } = update;
  if (!inspection.value.teams[team_num]) {
    inspection.value.teams[team_num] = { inspectors: {}, results: {} };
  }
  inspection.value.teams[team_num].results[category_id] = result;
});

// SSE로 검차 답변(코너웨이트) 실시간 반영
watch(lastAnswerUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete inspection.value.teams[update.team_num];
    if (inspection.value.cornerWeight?.teams) delete inspection.value.cornerWeight.teams[update.team_num];
    debouncedRefresh();
    return;
  }
  if (update.renumbered) {
    if (inspection.value.teams[update.prevNum]) {
      inspection.value.teams[update.team_num] = inspection.value.teams[update.prevNum];
      delete inspection.value.teams[update.prevNum];
    }
    const cwTeams = inspection.value.cornerWeight?.teams;
    if (cwTeams?.[update.prevNum]) {
      cwTeams[update.team_num] = cwTeams[update.prevNum];
      delete cwTeams[update.prevNum];
    }
    debouncedRefresh();
    return;
  }
  const { team_num, item_id, value } = update;

  // 코너웨이트 항목 매칭
  const cw = inspection.value.cornerWeight;
  if (cw) {
    const keyMap = { [cw.items.curb]: "curb", [cw.items.fl]: "fl", [cw.items.fr]: "fr", [cw.items.rl]: "rl", [cw.items.rr]: "rr" };
    const key = keyMap[item_id];
    if (key) {
      if (!cw.teams[team_num]) cw.teams[team_num] = {};
      cw.teams[team_num][key] = value;
    }
  }

});

// SSE로 수동 점수 실시간 반영
watch(lastManualScoreUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  if (update.deleted) {
    delete manualScores.value[update.team_num];
    return;
  }
  if (update.renumbered) {
    if (manualScores.value[update.prevNum]) {
      manualScores.value[update.team_num] = manualScores.value[update.prevNum];
      delete manualScores.value[update.prevNum];
    }
    return;
  }
  const { team_num, score_type, value } = update;
  if (!manualScores.value[team_num]) manualScores.value[team_num] = {};
  manualScores.value[team_num][score_type] = value;
});

// SSE 이벤트 데이터만 갱신 (manualScores/penalties/settings는 전용 SSE watcher가 처리)
async function refreshEventData() {
  const year = selectedYear.value;
  const seq = ++refreshSeq;
  try {
    const data = await fetchScore(year);
    if (seq !== refreshSeq || selectedYear.value !== year) return;
    entries.value = data.entries;
    inspection.value = data.inspection;
    events.value = data.events;
    energy.value = data.energy || { teams: {}, config: {}, references: {} };
  } catch (e) {
    if (seq === refreshSeq && selectedYear.value === year) error("데이터를 가져올 수 없습니다.");
  }
}

const { debounce: debounceRefresh } = createKeyedDebouncer(300);
function debouncedRefresh() {
  debounceRefresh("refresh", refreshEventData);
}

// SSE로 페널티 설정 실시간 반영
watch(lastPenaltyUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, cone_penalty, oc_penalty, start_delay } = update;
  if (!penalties.value[event_type]) penalties.value[event_type] = {};
  penalties.value[event_type].cone_penalty = cone_penalty;
  penalties.value[event_type].oc_penalty = oc_penalty;
  penalties.value[event_type].start_delay = start_delay;
  debouncedRefresh(); // 내구 result는 백엔드에서 start_delay 포함 계산되므로 재로드 필요
});

// SSE로 점수 설정 실시간 반영
watch(lastSettingUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, setting_key, value } = update;
  if (!settings.value[event_type]) settings.value[event_type] = {};
  settings.value[event_type][setting_key] = value;
  debouncedRefresh();
});

// SSE로 경기 기록 변경 시 이벤트 데이터 갱신
watch(lastTrafficRecordUpdate, () => {
  debouncedRefresh();
});

// SSE로 내구 기록 변경 시 이벤트 데이터 갱신
watch(lastEnduranceUpdate, () => {
  debouncedRefresh();
});

watch(lastPublicationUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  publicEnabled.value = !!update.enabled;
});

// SSE 재연결 시 전체 데이터 동기화
watch(reconnected, () => {
  if (reconnected.value) Promise.all([loadData(), loadTypeColors()]);
});

// 카테고리 오버라이드 판별
function isOverriddenCategory(catId) {
  return catId === inspection.value.cornerWeight?.categoryId;
}

function getOverrideKey(catId) {
  if (catId === inspection.value.cornerWeight?.categoryId) return "cornerWeight";
  return null;
}

// 코너웨이트 헬퍼
function getCurbWeight(num) {
  return inspection.value.cornerWeight?.teams[num]?.curb ?? null;
}

function getCornerWeight(num) {
  return inspection.value.cornerWeight?.teams[num] ?? null;
}

function getFRRatio(num) {
  const cw = getCornerWeight(num);
  if (!cw) return null;
  const fl = Number(cw.fl), fr = Number(cw.fr), rl = Number(cw.rl), rr = Number(cw.rr);
  if (!fl || !fr || !rl || !rr) return null;
  const total = fl + fr + rl + rr;
  const front = ((fl + fr) / total * 100).toFixed(1);
  const rear = ((rl + rr) / total * 100).toFixed(1);
  return { front, rear };
}

function getLRRatio(num) {
  const cw = getCornerWeight(num);
  if (!cw) return null;
  const fl = Number(cw.fl), fr = Number(cw.fr), rl = Number(cw.rl), rr = Number(cw.rr);
  if (!fl || !fr || !rl || !rr) return null;
  const total = fl + fr + rl + rr;
  const left = ((fl + rl) / total * 100).toFixed(1);
  const right = ((fr + rr) / total * 100).toFixed(1);
  return { left, right };
}

// 세부 기록 확장 행
const allEvents = computed(() => [...dynamicEvents.value, enduranceEvent.value]);

const totalColumns = computed(() => {
  let cols = 3; // num, team, type
  if (showInspection.value) cols += inspection.value.categories.length;
  cols += 1; // total
  cols += dynamicEvents.value.length; // dynamic events
  cols += 1; // endurance
  cols += 4; // report, calculated energy, bonus, deduction
  return cols;
});

function handleRowClick(num, event) {
  if (event.target.closest(".col-corner-weight, .manual-input, .setting-cell, input, button, a")) return;
  detailExpandedTeam.value = detailExpandedTeam.value === num ? null : num;
}

function getAllRuns(eventType, num) {
  const evt = events.value.find((e) => e.type === eventType);
  return evt?.records[num]?.allRuns || [];
}

function getRunAdjusted(eventType, run) {
  if (!run || run.result == null || run.result < 0) return run?.result ?? null;
  const pen = penalties.value[eventType] || {};
  return run.result + (run.cones || 0) * (pen.cone_penalty || 0) * 1000 + (run.oc || 0) * (pen.oc_penalty || 0) * 1000;
}

function getBestRunIndex(eventType, num) {
  const runs = getAllRuns(eventType, num);
  const pen = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0 };
  let bestIdx = -1;
  let bestAdj = Infinity;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.invalidated) continue;
    if (r.result == null || r.result < 0) continue;
    const adj = r.result + (r.cones || 0) * pen.cone_penalty * 1000 + (r.oc || 0) * pen.oc_penalty * 1000;
    if (adj < bestAdj) { bestAdj = adj; bestIdx = i; }
  }
  return bestIdx;
}

function getSortedRuns(eventType, num) {
  const runs = getAllRuns(eventType, num);
  const indexed = runs.map((r, i) => ({ ...r, origIndex: i }));
  if (detailSortMode.value === "score") {
    const pen = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0 };
    indexed.sort((a, b) => {
      if (a.invalidated && !b.invalidated) return 1;
      if (!a.invalidated && b.invalidated) return -1;
      const aAdj = a.result != null && a.result >= 0 ? a.result + (a.cones || 0) * pen.cone_penalty * 1000 + (a.oc || 0) * pen.oc_penalty * 1000 : Infinity;
      const bAdj = b.result != null && b.result >= 0 ? b.result + (b.cones || 0) * pen.cone_penalty * 1000 + (b.oc || 0) * pen.oc_penalty * 1000 : Infinity;
      return aAdj - bAdj;
    });
  }
  return indexed;
}

function hasAnyRuns(num) {
  return allEvents.value.some((evt) => getAllRuns(evt.type, num).length > 0);
}

function toggleCornerWeight(num) {
  if (expandedRows.value.has(num)) {
    expandedRows.value.delete(num);
  } else {
    expandedRows.value.add(num);
  }
}

function exportData(format) {
  const headers = ["번호", "학교", "팀", "유형"];
  if (showInspection.value) {
    for (const cat of inspection.value.categories) headers.push(cat.name);
  }
  headers.push("총점");
  for (const evt of dynamicEvents.value) headers.push(evt.type);
  headers.push("내구", "보고서", "에너지", "가점", "감점");

  const rows = entryList.value.map((entry) => {
    const row = [entry.num, entry.univ || "", entry.team || "", entry.type || ""];
    if (showInspection.value) {
      for (const cat of inspection.value.categories) {
        if (!categoryAppliesTo(cat, entry.type)) { row.push(""); continue; }
        row.push(isOverriddenCategory(cat.id) ? (getCurbWeight(entry.num) ?? "") : (getInspectionResult(entry.num, cat.id) || ""));
      }
    }
    row.push(getTotalScore(entry.num));
    for (const evt of dynamicEvents.value) {
      row.push(displayMode.value === "score" ? (getEventScore(evt.type, entry.num) ?? "") : (formatResult(getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)))));
    }
    const endRec = getTeamEvent(enduranceEvent.value, entry.num);
    row.push(displayMode.value === "score" ? (getEventScore("내구", entry.num) ?? "") : formatResult(getAdjustedResult("내구", endRec)));
    const energyResult = getEnergyResult(entry.num);
    row.push(
      getManualScore(entry.num, "report") ?? "",
      energyResult?.status === "DSQ" ? `DSQ: ${energyResult.reason}` : (getEnergyScore(entry.num) ?? ""),
      getManualScore(entry.num, "bonus") ?? "",
      getManualScore(entry.num, "deduction") ?? "",
    );
    return row;
  });

  exportTable({ sheetName: "성적표", fileBase: `성적표_${selectedYear.value}`, headers, rows, format });
}
</script>

<template>
  <div class="score-page">
    <div class="top-row">
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
        <div class="filter-group type-filter-gap">
          <label class="filter-label">필터</label>
          <label class="filter-checkbox">
            <input type="checkbox" v-model="showInspection" />
            <span>검차</span>
          </label>
        </div>
        <div class="filter-group type-filter-gap" v-if="vehicleTypes.length > 1">
          <label class="filter-label">유형</label>
          <div class="type-filter-group">
            <label v-for="t in vehicleTypes" :key="t" class="filter-checkbox">
              <input type="checkbox" v-model="typeFilters[t]" />
              <span class="badge" :class="'badge-type-' + getTypeColor(t)">{{ t }}</span>
            </label>
          </div>
        </div>
        <div class="filter-group type-filter-gap">
          <label class="filter-label">표시</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: displayMode === 'record' }" @click="displayMode = 'record'">기록</button>
            <button class="mode-btn" :class="{ active: displayMode === 'score' }" @click="displayMode = 'score'">점수</button>
          </div>
        </div>
        <div class="filter-group action-group">
          <label class="filter-label">&nbsp;</label>
          <div class="action-buttons">
            <button class="action-link" @click="exportData('csv')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>CSV</button>
            <button class="action-link" @click="exportData('xlsx')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>XLSX</button>
            <router-link to="/endurance" class="action-link nav-link">내구 입력</router-link>
          </div>
        </div>
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <!-- 메인 테이블 -->
    <div class="card">
      <div class="card-header score-card-header">
        <div class="header-left">
          <h3>성적표</h3>
          <span class="count-badge">{{ entryList.length }}개 팀</span>
        </div>
        <div class="publication-actions">
          <label class="publication-toggle">
            <span>공개</span>
            <span class="toggle-switch">
              <input
                type="checkbox"
                :checked="publicEnabled"
                :disabled="publicationLoading"
                role="switch"
                :aria-checked="publicEnabled"
                @change="handlePublicationToggle($event.target.checked)"
              />
              <span class="toggle-slider"></span>
            </span>
          </label>
          <a
            v-if="publicEnabled"
            :href="publicPageUrl"
            class="btn btn-ghost btn-sm public-link"
            target="_blank"
            rel="noopener noreferrer"
            title="공개 페이지 열기"
          >공개</a>
          <button v-else type="button" class="btn btn-ghost btn-sm public-link" disabled>공개</button>
        </div>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="sticky-host">
          <div class="table-container">
          <table ref="tableRef" class="data-table score-table" :data-sticky-cols="stickyCols" @keydown="handleKeyNav">
            <thead>
              <tr>
                <th class="col-num sortable" @click="handleSort('num')">번호 <span class="sort-icon">{{ getSortIcon('num') }}</span></th>
                <th class="col-team sortable" @click="handleSort('team')">학교 / 팀 <span class="sort-icon">{{ getSortIcon('team') }}</span></th>
                <th class="col-type sortable" @click="handleSort('type')">유형 <span class="sort-icon">{{ getSortIcon('type') }}</span></th>
                <th
                  v-for="cat in inspection.categories"
                  :key="'h-insp-'+cat.id"
                  class="col-inspection"
                  :class="{ sortable: isOverriddenCategory(cat.id) }"
                  v-show="showInspection"
                  @click="isOverriddenCategory(cat.id) && handleSort(getOverrideKey(cat.id))"
                >{{ cat.name }} <span v-if="isOverriddenCategory(cat.id)" class="sort-icon">{{ getSortIcon(getOverrideKey(cat.id)) }}</span></th>
                <th class="col-total sortable" @click="handleSort('totalScore')">총점 <span class="sort-icon">{{ getSortIcon('totalScore') }}</span></th>
                <th
                  v-for="evt in dynamicEvents"
                  :key="'h-evt-'+evt.type"
                  class="col-event sortable"
                  @click="handleSort('event:' + evt.type)"
                >{{ evt.type }} <span class="sort-icon">{{ getSortIcon('event:' + evt.type) }}</span></th>
                <th class="col-event sortable" @click="handleSort('event:내구')">내구 <span class="sort-icon">{{ getSortIcon('event:내구') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('report')">보고서 <span class="sort-icon">{{ getSortIcon('report') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('energy')">에너지 <span class="sort-icon">{{ getSortIcon('energy') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('bonus')">가점 <span class="sort-icon">{{ getSortIcon('bonus') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('deduction')">감점 <span class="sort-icon">{{ getSortIcon('deduction') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="entry in entryList" :key="entry.num">
              <tr class="team-row" :class="{ 'expanded-row': detailExpandedTeam === entry.num }" @click="handleRowClick(entry.num, $event)">
                  <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                  <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                  <td class="col-type"><span class="badge" :class="'badge-type-' + getTypeColor(entry.type)" v-if="entry.type">{{ entry.type }}</span></td>
                  <template v-for="cat in inspection.categories" :key="'insp-'+cat.id+'-'+entry.num">
                    <!-- 이 차량 유형에 표시하지 않는 카테고리 → 빈 칸 -->
                    <td
                      v-if="!categoryAppliesTo(cat, entry.type)"
                      v-show="showInspection"
                      class="col-inspection"
                    ></td>
                    <!-- 코너웨이트 카테고리 → 공차중량 값 + 드롭다운 -->
                    <td
                      v-else-if="inspection.cornerWeight?.categoryId === cat.id"
                      v-show="showInspection"
                      class="col-inspection col-corner-weight"
                      @click="toggleCornerWeight(entry.num)"
                    >
                      <span v-if="getCurbWeight(entry.num)" class="cw-value">{{ getCurbWeight(entry.num) }} kg</span>
                      <span v-else class="badge badge-empty">-</span>
                      <div
                        v-if="expandedRows.has(entry.num) && getCornerWeight(entry.num)"
                        class="cw-dropdown"
                        @click.stop
                      >
                        <div class="cw-dropdown-grid">
                          <div class="cw-cell"><span class="cw-label">FL</span><span class="cw-val">{{ getCornerWeight(entry.num).fl ? getCornerWeight(entry.num).fl + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">FR</span><span class="cw-val">{{ getCornerWeight(entry.num).fr ? getCornerWeight(entry.num).fr + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">RL</span><span class="cw-val">{{ getCornerWeight(entry.num).rl ? getCornerWeight(entry.num).rl + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">RR</span><span class="cw-val">{{ getCornerWeight(entry.num).rr ? getCornerWeight(entry.num).rr + ' kg' : '-' }}</span></div>
                          <template v-if="getFRRatio(entry.num)">
                            <hr class="cw-divider">
                            <div class="cw-cell"><span class="cw-label">F</span><span class="cw-val">{{ getFRRatio(entry.num).front }}%</span></div>
                            <div class="cw-cell"><span class="cw-label">R</span><span class="cw-val">{{ getFRRatio(entry.num).rear }}%</span></div>
                            <hr class="cw-divider">
                            <div class="cw-cell"><span class="cw-label">L</span><span class="cw-val">{{ getLRRatio(entry.num).left }}%</span></div>
                            <div class="cw-cell"><span class="cw-label">R</span><span class="cw-val">{{ getLRRatio(entry.num).right }}%</span></div>
                          </template>
                        </div>
                      </div>
                    </td>
                    <!-- 일반 카테고리 → PASS/FAIL -->
                    <td
                      v-else
                      v-show="showInspection"
                      class="col-inspection"
                    >
                      <span
                        v-if="getInspectionResult(entry.num, cat.id)"
                        class="badge"
                        :class="getInspectionResult(entry.num, cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
                      >{{ getInspectionResult(entry.num, cat.id) }}</span>
                      <span v-else class="badge badge-empty">-</span>
                    </td>
                  </template>
                  <td class="col-total">
                    <span class="total-value">{{ getTotalScore(entry.num) }}</span>
                  </td>
                  <td
                    v-for="evt in dynamicEvents"
                    :key="'evt-'+evt.type+'-'+entry.num"
                    class="col-event"
                  >
                    <template v-if="displayMode === 'record'">
                      <span
                        v-if="getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)) != null"
                        class="record-value"
                        :class="{ dnf: getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)) === -1 }"
                      >{{ formatResult(getAdjustedResult(evt.type, getTeamEvent(evt, entry.num))) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                    <template v-else>
                      <span v-if="getEventScore(evt.type, entry.num) != null" class="score-value">{{ getEventScore(evt.type, entry.num) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                  </td>
                  <td class="col-event">
                    <template v-if="displayMode === 'record'">
                      <span
                        v-if="getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num)) != null"
                        class="record-value"
                        :class="{ dnf: getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num)) === -1 }"
                      >{{ formatResult(getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num))) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                    <template v-else>
                      <span v-if="getEventScore('내구', entry.num) != null" class="score-value">{{ getEventScore('내구', entry.num) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                  </td>
                  <td class="col-manual" :class="{ 'manual-over-max': isReportOverMax(entry.num) }" :title="isReportOverMax(entry.num) ? '보고서 총점을 초과한 기존 점수입니다.' : ''">
                    <input
                      class="manual-input"
                      type="number"
                      :max="getSetting('보고서', 'total') ?? undefined"
                      :value="getManualScore(entry.num, 'report')"
                      :disabled="isReadOnly"
                      @blur="handleManualSave(entry.num, 'report', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
                  <td class="col-manual">
                    <span
                      v-if="getEnergyResult(entry.num)?.status === 'DSQ'"
                      class="badge badge-danger energy-result"
                      :title="getEnergyTitle(entry.num)"
                    >DSQ</span>
                    <span
                      v-else-if="getEnergyScore(entry.num) != null"
                      class="score-value energy-result"
                      :title="getEnergyTitle(entry.num)"
                    >{{ getEnergyScore(entry.num) }}</span>
                    <span v-else class="record-value dns energy-result" :title="getEnergyTitle(entry.num)">{{ getEnergyResult(entry.num)?.status === 'PENDING' ? '대기' : '-' }}</span>
                  </td>
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'bonus')"
                      :disabled="isReadOnly"
                      @blur="handleManualSave(entry.num, 'bonus', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'deduction')"
                      :disabled="isReadOnly"
                      @blur="handleManualSave(entry.num, 'deduction', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
              </tr>
              <tr v-if="detailExpandedTeam === entry.num" class="detail-row">
                <td :colspan="totalColumns">
                  <div class="detail-content" v-if="hasAnyRuns(entry.num)">
                    <table class="detail-runs-table">
                      <thead>
                        <tr>
                          <th>종목</th>
                          <th>시각</th>
                          <th>기록</th>
                          <th>콘터치</th>
                          <th>코스 이탈</th>
                          <th>최종</th>
                          <th>
                            <div class="detail-sort-toggle" @click.stop>
                              <button class="detail-sort-btn" :class="{ active: detailSortMode === 'time' }" @click="detailSortMode = 'time'">시간순</button>
                              <button class="detail-sort-btn" :class="{ active: detailSortMode === 'score' }" @click="detailSortMode = 'score'">성적순</button>
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <template v-for="evt in allEvents" :key="evt.type">
                          <tr
                            v-for="(run, idx) in getSortedRuns(evt.type, entry.num)"
                            :key="evt.type + '-' + idx"
                            :data-evt-group="entry.num + ':' + evt.type"
                            :class="{ 'run-best': !run.invalidated && run.origIndex === getBestRunIndex(evt.type, entry.num), 'evt-first-row': idx === 0 }"
                            @mouseenter="hoveredEvtGroup = entry.num + ':' + evt.type"
                            @mouseleave="hoveredEvtGroup = null"
                          >
                            <td v-if="idx === 0" class="col-evt-type" :class="{ 'evt-group-hover': hoveredEvtGroup === entry.num + ':' + evt.type }" :rowspan="getSortedRuns(evt.type, entry.num).length">{{ evt.type }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.time ? formatTime(run.time) : '-' }}</td>
                            <td class="run-time" :class="{ 'run-invalidated': run.invalidated, 'run-dnf': run.result === -1 }">{{ run.result != null && run.result >= 0 ? formatResult(run.result) : (run.result === -1 ? 'DNF' : '-') }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.cones || 0 }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.oc || 0 }}</td>
                            <td class="run-time" :class="{ 'run-invalidated': run.invalidated }">{{ !run.invalidated && run.result != null && run.result >= 0 ? formatResult(getRunAdjusted(evt.type, run)) : '-' }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">
                              <span v-if="!run.invalidated && run.origIndex === getBestRunIndex(evt.type, entry.num)" class="badge badge-success">최고</span>
                              <span v-else-if="run.invalidated" class="badge badge-danger">무효</span>
                            </td>
                          </tr>
                        </template>
                      </tbody>
                    </table>
                  </div>
                  <div v-else class="detail-empty">경기 기록이 없습니다</div>
                </td>
              </tr>
              </template>
              <tr v-if="entryList.length === 0">
                <td :colspan="9 + inspection.categories.length + dynamicEvents.length" class="empty-state">
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

    <!-- 페널티 + 점수 설정 -->
    <div class="bottom-row" v-if="events.length > 0">
      <div class="card setting-card">
        <div class="card-body table-body">
          <div class="table-container">
            <table class="data-table setting-table">
              <thead>
                <tr>
                  <th class="col-setting-label">페널티 (초)</th>
                  <th v-for="evt in dynamicEvents" :key="'penalty-h-'+evt.type" class="col-setting-value">{{ evt.type }}</th>
                  <th class="col-setting-value">내구</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="{ field, label } in [{ field: 'cone_penalty', label: '콘터치' }, { field: 'oc_penalty', label: '코스이탈' }, { field: 'start_delay', label: '출발지연' }]" :key="field">
                  <td class="col-setting-label">{{ label }}</td>
                  <template v-for="evtType in [...dynamicEvents.map(e => e.type), '내구']" :key="'p-'+field+'-'+evtType">
                    <td v-if="field !== 'start_delay' || evtType === '내구'" class="col-setting-value setting-cell" @click="startSettingEdit('p:'+field+':'+evtType)">
                      <input
                        v-if="editingSettingCell === 'p:'+field+':'+evtType"
                        :ref="settingInputRef"
                        class="setting-input"
                        type="number"
                        step="any"
                        min="0"
                        :value="getPenalty(evtType, field)"
                        @blur="handlePenaltySave(evtType, field, $event.target.value)"
                        @keyup.enter="$event.target.blur()"
                      />
                      <span v-else class="setting-text">{{ getPenalty(evtType, field) || 0 }}</span>
                    </td>
                    <td v-else class="col-setting-value">-</td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card setting-card">
        <div class="card-body table-body">
          <div class="table-container">
            <table class="data-table setting-table">
              <thead>
                <tr>
                  <th class="col-setting-label">점수</th>
                  <th v-for="evtType in [...dynamicEvents.map(e => e.type), '내구', '보고서', '에너지']" :key="'score-h-'+evtType" class="col-setting-value">{{ evtType }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="{ key, label } in [{ key: 'total', label: '총점' }, { key: 'finish', label: '완주점수' }, { key: 'cutoff', label: '컷오프 (%)' }]" :key="key">
                  <td class="col-setting-label">{{ label }}</td>
                  <template v-for="evtType in [...dynamicEvents.map(e => e.type), '내구', '보고서', '에너지']" :key="'s-'+key+'-'+evtType">
                    <td
                      v-if="key === 'total' || !['보고서', '에너지'].includes(evtType)"
                      class="col-setting-value setting-cell"
                      @click="startSettingEdit('s:'+key+':'+evtType)"
                    >
                      <input
                        v-if="editingSettingCell === 's:'+key+':'+evtType"
                        :ref="settingInputRef"
                        class="setting-input"
                        type="number"
                        step="any"
                        min="0"
                        :value="getSetting(evtType, key)"
                        @blur="handleSettingSave(evtType, key, $event.target.value)"
                        @keyup.enter="$event.target.blur()"
                      />
                      <span v-else class="setting-text">{{ getSetting(evtType, key) ?? '-' }}</span>
                    </td>
                    <td v-else class="col-setting-value setting-na">-</td>
                  </template>
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
.score-page {
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

.score-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 1rem;
}

.score-card-header .header-left h3 {
  white-space: nowrap;
}

.publication-actions,
.publication-toggle {
  display: flex;
  align-items: center;
}

.publication-actions {
  flex: 0 0 auto;
  gap: 0.75rem;
  margin-left: auto;
  white-space: nowrap;
}

.publication-toggle {
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
  user-select: none;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border-color);
  border-radius: 999px;
  transition: background-color 0.2s;
}

.toggle-slider::before {
  content: "";
  position: absolute;
  width: 16px;
  height: 16px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--accent-success);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(18px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.toggle-switch input:disabled + .toggle-slider {
  cursor: wait;
  opacity: 0.55;
}

.public-link {
  min-width: 3.25rem;
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

.score-table {
  min-width: 700px;
}

.score-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  white-space: nowrap;
  font-size: 0.875rem;
}

.score-table th.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.score-table th.sortable:hover {
  background: var(--bg-hover);
}

.sort-icon {
  display: inline-block;
  width: 1em;
  text-align: center;
  opacity: 0.5;
  font-size: 0.75rem;
  margin-left: 0.25rem;
}

.col-num,
.col-team,
.col-type,
.col-inspection,
.col-event,
.col-manual {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  text-align: center !important;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.score-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
}

.score-table[data-sticky-cols="2"] .col-team,
.score-table[data-sticky-cols="3"] .col-team {
  position: sticky;
  left: var(--sticky-l1, 0);
  z-index: 1;
  background: var(--bg-card);
}

.score-table[data-sticky-cols="3"] .col-type {
  position: sticky;
  left: var(--sticky-l2, 0);
  z-index: 1;
  background: var(--bg-card);
}

.score-table[data-sticky-cols="2"] thead .col-team,
.score-table[data-sticky-cols="3"] thead .col-team,
.score-table[data-sticky-cols="3"] thead .col-type {
  z-index: 3;
}

.col-team {
  font-size: 0.875rem;
}

.col-type,
.col-inspection,
.col-event,
.col-manual {
  text-align: center !important;
}

.badge-empty {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.col-total {
  text-align: center !important;
  white-space: nowrap;
  width: 1%;
  background: rgba(94, 106, 210, 0.04);
}

.score-table thead .col-total {
  font-weight: 700;
}

.total-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--accent-primary);
}

.record-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--accent-success);
}

.record-value.dnf {
  color: var(--accent-danger);
}

.record-value.dns {
  color: var(--text-tertiary);
  font-weight: 400;
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

.action-group {
  margin-left: auto;
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  height: 2.125rem;
}

/* Mode toggle */
.mode-toggle {
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  height: 2.125rem;
}

.mode-btn {
  padding: 0 0.75rem;
  border: none;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-btn + .mode-btn {
  border-left: 1px solid var(--border-color);
}

.mode-btn.active {
  background: var(--accent-primary);
  color: white;
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

.score-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--accent-primary);
}

/* Filter checkbox */
.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  user-select: none;
  height: 2.125rem;
}

.filter-checkbox input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent-primary);
  cursor: pointer;
}

/* Corner weight */
.col-corner-weight {
  cursor: pointer;
  user-select: none;
  position: relative;
}

.col-corner-weight:hover {
  background: var(--bg-hover);
}

.cw-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
}

.cw-dropdown {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  padding: 0.625rem 0.875rem;
  min-width: 160px;
}

.cw-dropdown-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
}

.cw-cell {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.cw-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.cw-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
}

.cw-divider {
  grid-column: 1 / -1;
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 0.125rem 0;
}

/* Manual score inline edit */
.manual-input {
  width: 4rem;
  padding: 0.125rem 0.25rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  cursor: pointer;
  -moz-appearance: textfield;
}

.manual-input:focus {
  border-color: var(--accent-primary);
  background: var(--bg-input);
  cursor: text;
}

.manual-input::placeholder {
  color: var(--text-tertiary);
}

.manual-over-max {
  background: rgba(239, 68, 68, 0.1);
}

.manual-over-max .manual-input {
  color: var(--accent-danger);
  font-weight: 700;
}

.manual-input::-webkit-outer-spin-button,
.manual-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Bottom row: penalty + score settings */
.bottom-row {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

.bottom-row > .setting-card {
  min-width: 0;
  overflow: hidden;
}

.bottom-row > .setting-card:first-child {
  flex: 0 1 40%;
}

.bottom-row > .setting-card:last-child {
  flex: 1 1 60%;
  min-width: 0;
  overflow: hidden;
}

.setting-table {
  min-width: max-content;
  width: 100%;
}

.col-setting-label {
  white-space: nowrap;
  width: 1%;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.setting-table thead .col-setting-label {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  z-index: 3;
}

.setting-table tbody .col-setting-label {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.col-setting-value {
  text-align: center !important;
  white-space: nowrap;
  min-width: 5.25rem;
}

.setting-input {
  width: 3.5rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.setting-input:focus {
  border-color: var(--accent-primary);
}

.setting-input::placeholder {
  color: var(--text-tertiary);
}

.setting-input::-webkit-outer-spin-button,
.setting-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.setting-cell {
  cursor: pointer;
}

.setting-cell:hover {
  background: var(--bg-hover);
}

.setting-text {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
}

.setting-na {
  color: var(--text-tertiary);
  background: var(--bg-secondary);
}

.energy-result {
  cursor: help;
}

@media (max-width: 1100px) {
  .bottom-row {
    flex-direction: column;
  }

  .bottom-row > .setting-card:first-child,
  .bottom-row > .setting-card:last-child {
    width: 100%;
    flex-basis: auto;
  }
}


/* Team row expandable */
.team-row {
  cursor: pointer;
}

.team-row:hover {
  background: var(--bg-hover);
}

.expanded-row {
  background: rgba(94, 106, 210, 0.04);
}

.expanded-row .col-num {
  background: var(--bg-card);
}

/* Detail row */
.detail-row {
  background: var(--bg-secondary);
}

.detail-row:hover {
  background: var(--bg-secondary);
}

.detail-row > td {
  padding: 1.5rem 0 !important;
}

.detail-row .detail-content,
.detail-row .detail-empty {
  position: sticky;
  left: 0;
  max-width: 100vw;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 2rem;
  box-sizing: border-box;
}

.detail-sort-toggle {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.detail-sort-btn {
  padding: 0.125rem 0.5rem;
  border: none;
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.detail-sort-btn + .detail-sort-btn {
  border-left: 1px solid var(--border-color);
}

.detail-sort-btn.active {
  background: var(--accent-primary);
  color: white;
}

.detail-runs-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}

.detail-runs-table th,
.detail-runs-table td {
  padding: 0.375rem 1rem;
  text-align: center;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
}

.detail-runs-table .evt-first-row td {
  border-top: 2px solid var(--border-color);
}

.detail-runs-table .evt-first-row .col-evt-type {
  border-top: 2px solid var(--border-color);
}

.detail-runs-table th {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.detail-runs-table .col-evt-type {
  font-weight: 600;
  color: var(--text-secondary);
  border-right: 1px solid var(--border-color);
  vertical-align: middle;
}

.detail-runs-table .col-evt-type.evt-group-hover {
  background: var(--bg-hover);
}

.detail-runs-table .run-time {
  font-family: "JetBrains Mono", monospace;
  font-weight: 500;
}

.run-best td:not(.col-evt-type) {
  background: rgba(34, 197, 94, 0.08);
}

td.run-invalidated {
  opacity: 0.45;
  text-decoration: line-through;
}

td.run-dnf {
  color: var(--accent-danger);
  font-weight: 700;
}

.detail-empty {
  text-align: center;
  color: var(--text-tertiary);
  padding: 1rem;
  font-size: 0.9375rem;
}

@media (max-width: 640px) {
  .top-row,
  .bottom-row {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-group {
    width: 100%;
  }

  .mode-toggle {
    width: fit-content;
  }

  .filter-input {
    width: 100%;
    box-sizing: border-box;
  }

}
</style>
