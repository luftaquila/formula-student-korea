<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { fetchPublicScore, fetchVehicleTypes } from "../api";
import { createSSEConnection, parseSSEData } from "@shared/useSSE.js";

const route = useRoute();
const year = Number(route.params.year);
const base = import.meta.env.PROD ? "/score" : "";

const loading = ref(true);
const unavailable = ref(false);
const loadFailed = ref(false);
const entries = ref({});
const events = ref([]);
const typeColorMap = ref({});
const sortKey = ref(null);
const sortOrder = ref("asc");

const { on, useSSE, reconnect } = createSSEConnection(`${base}/api/score/public/${year}/events`);

let requestSeq = 0;
let refreshTimer = null;
let initCount = 0;
const vehicleTypesRequest = fetchVehicleTypes(year).catch(() => []);

async function loadData() {
  const seq = ++requestSeq;
  try {
    const [data, vehicleTypes] = await Promise.all([fetchPublicScore(year), vehicleTypesRequest]);
    if (seq !== requestSeq) return;
    entries.value = data.entries || {};
    events.value = (data.events || []).filter((event) => event.type !== "내구");
    typeColorMap.value = Object.fromEntries(vehicleTypes.map((type) => [type.name, type.color]));
    unavailable.value = false;
    loadFailed.value = false;
  } catch (error) {
    if (seq !== requestSeq) return;
    if (error.status === 404) unavailable.value = true;
    else loadFailed.value = true;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadData, 250);
}

on("init", () => {
  // onMounted의 최초 조회와 중복되지 않도록 최초 init은 연결 확인으로만 사용한다.
  if (++initCount > 1) scheduleRefresh();
});
on("refresh", scheduleRefresh);
on("publication", (event) => {
  const data = parseSSEData(event);
  if (data?.year !== year) return;
  if (data.enabled) scheduleRefresh();
  else {
    // 이미 진행 중인 HTTP 응답이 비공개 전환 후 테이블을 되살리지 못하게 무효화한다.
    requestSeq++;
    clearTimeout(refreshTimer);
    // 현재 슬롯은 즉시 반납하되 비공개 상태에서도 재시도하여 재공개를 자동 감지한다.
    reconnect();
    unavailable.value = true;
    loadFailed.value = false;
    loading.value = false;
    entries.value = {};
    events.value = [];
  }
});
useSSE();

onMounted(loadData);
onUnmounted(() => clearTimeout(refreshTimer));

function resultFor(event, teamNum) {
  return event?.records?.[teamNum]?.result ?? null;
}

function getTypeColor(type) {
  return typeColorMap.value[type] || "blue";
}

function formatResult(result) {
  if (result === -1) return "DNF";
  if (result == null) return "-";
  const milliseconds = Number(result);
  if (!Number.isFinite(milliseconds)) return String(result);
  const rounded = Math.round(Math.abs(milliseconds));
  const millis = String(rounded % 1000).padStart(3, "0");
  const seconds = String(Math.floor(rounded / 1000) % 60).padStart(2, "0");
  const minutes = String(Math.floor(rounded / 60000)).padStart(2, "0");
  return `${minutes}:${seconds}.${millis}`;
}

const entryList = computed(() => {
  const list = Object.entries(entries.value).map(([num, entry]) => ({ num: Number(num), ...entry }));
  if (!sortKey.value) return list.sort((a, b) => a.num - b.num);

  return list.sort((a, b) => {
    let left;
    let right;
    if (sortKey.value === "num") {
      left = a.num;
      right = b.num;
    } else if (sortKey.value === "team") {
      left = `${a.univ || ""} ${a.team || ""}`.toLowerCase();
      right = `${b.univ || ""} ${b.team || ""}`.toLowerCase();
    } else if (sortKey.value === "type") {
      left = (a.type || "").toLowerCase();
      right = (b.type || "").toLowerCase();
    } else {
      const eventType = sortKey.value.slice(6);
      const event = events.value.find((item) => item.type === eventType);
      const normalize = (value) => value == null ? Number.MAX_VALUE : value === -1 ? Number.MAX_SAFE_INTEGER : Number(value);
      left = normalize(resultFor(event, a.num));
      right = normalize(resultFor(event, b.num));
    }
    if (left < right) return sortOrder.value === "asc" ? -1 : 1;
    if (left > right) return sortOrder.value === "asc" ? 1 : -1;
    return a.num - b.num;
  });
});

function handleSort(key) {
  if (sortKey.value === key) sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
}

function sortIcon(key) {
  if (sortKey.value !== key) return "↕";
  return sortOrder.value === "asc" ? "↑" : "↓";
}
</script>

<template>
  <div class="public-score-page">
    <div v-if="unavailable" class="card state-card">
      <div class="state-icon">🔒</div>
      <h2>현재 공개되지 않은 성적표입니다</h2>
      <p>성적표 공개가 시작되면 이 페이지에서 확인할 수 있습니다.</p>
    </div>

    <div v-else-if="loadFailed" class="card state-card">
      <div class="state-icon">⚠️</div>
      <h2>성적표를 불러올 수 없습니다</h2>
      <p>잠시 후 다시 시도해주세요.</p>
      <button class="btn btn-primary" @click="loadData">다시 시도</button>
    </div>

    <div v-else class="card">
      <div class="card-header public-card-header">
        <div class="header-left">
          <h3>{{ year }}년 성적표</h3>
          <span class="count-badge">{{ entryList.length }}개 팀</span>
        </div>
        <span class="readonly-badge">읽기 전용</span>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="table-container">
          <table class="data-table score-table">
              <thead>
                <tr>
                  <th class="col-num sortable" @click="handleSort('num')">번호 <span class="sort-icon">{{ sortIcon('num') }}</span></th>
                  <th class="col-team sortable" @click="handleSort('team')">학교 / 팀 <span class="sort-icon">{{ sortIcon('team') }}</span></th>
                  <th class="col-type sortable" @click="handleSort('type')">유형 <span class="sort-icon">{{ sortIcon('type') }}</span></th>
                  <th
                    v-for="event in events"
                    :key="event.type"
                    class="col-event sortable"
                    @click="handleSort('event:' + event.type)"
                  >{{ event.type }} <span class="sort-icon">{{ sortIcon('event:' + event.type) }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in entryList" :key="entry.num">
                  <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                  <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                  <td class="col-type"><span v-if="entry.type" class="badge" :class="'badge-type-' + getTypeColor(entry.type)">{{ entry.type }}</span></td>
                  <td v-for="event in events" :key="event.type" class="col-event">
                    <span
                      class="record-value"
                      :class="{ dnf: resultFor(event, entry.num) === -1, dns: resultFor(event, entry.num) == null }"
                    >{{ formatResult(resultFor(event, entry.num)) }}</span>
                  </td>
                </tr>
                <tr v-if="entryList.length === 0">
                  <td :colspan="3 + events.length" class="empty-state">팀 데이터가 없습니다.</td>
                </tr>
              </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.public-score-page {
  min-height: calc(100vh - 8rem);
}

.public-card-header,
.header-left {
  display: flex;
  align-items: center;
}

.public-card-header {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.header-left {
  gap: 0.75rem;
}

.count-badge,
.readonly-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 999px;
}

.count-badge {
  color: #fff;
  background: var(--accent-primary);
}

.readonly-badge {
  margin-left: auto;
  color: var(--text-secondary);
  background: var(--bg-hover);
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
}

.score-table th.sortable:hover {
  background: var(--bg-hover);
}

.sort-icon {
  display: inline-block;
  width: 1em;
  margin-left: 0.25rem;
  text-align: center;
  opacity: 0.5;
  font-size: 0.75rem;
}

.col-num,
.col-team,
.col-type,
.col-event {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  position: sticky;
  left: 0;
  z-index: 1;
  text-align: center !important;
  background: var(--bg-card);
}

.score-table thead .col-num {
  z-index: 3;
}

.col-team {
  font-size: 0.875rem;
}

.col-type,
.col-event {
  text-align: center !important;
}

.record-value {
  color: var(--accent-success);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 700;
}

.record-value.dnf {
  color: var(--accent-danger);
}

.record-value.dns {
  color: var(--text-tertiary);
  font-weight: 400;
}

.state-card {
  max-width: 32rem;
  margin: 4rem auto;
  padding: 3rem 2rem;
  text-align: center;
}

.state-icon {
  margin-bottom: 1rem;
  font-size: 2.5rem;
}

.state-card h2 {
  margin-bottom: 0.5rem;
  font-size: 1.25rem;
}

.state-card p {
  margin-bottom: 1.25rem;
  color: var(--text-secondary);
}

</style>
