<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { useNotification } from "@shared/useNotification.js";
import {
  fetchEntries,
  fetchPublicQueues,
  fetchQueueState,
  fetchRegistrationLookup,
} from "../api";
import { useBoothTimers } from "../composables/useBoothTimers";
import { useRegistrationSSE } from "../composables/useRegistrationSSE";
import { useSSE } from "../composables/useSSE";
import { createCoalescedRefresh } from "../coalesced-refresh.js";
import { createLookupRefreshScheduler } from "../lookup-refresh.js";
import { isLookupEntryAvailable, isTerminalLookupError } from "../lookup-state.js";

const year = currentCompetitionYear();
const { error } = useNotification();
const {
  activeInspections,
  lastQueueUpdate,
  allBooths,
  lastBoothUpdate,
  lastEntriesUpdate,
  reconnected: queueReconnected,
} = useSSE();
const {
  registrationRevision,
  reconnected: registrationReconnected,
} = useRegistrationSSE();
const { elapsedTimes, syncTimers } = useBoothTimers();

const visibleInspections = computed(() =>
  activeInspections.value.filter((inspection) => !inspection.hidden_from_register),
);
const entries = ref({});
const publicQueues = ref([]);
const loading = ref(true);
const busy = ref(false);
const entryNum = ref("");
const lastQueryNum = ref("");
const hasQueried = ref(false);
const registrationWait = ref(null);
const queueEntries = ref([]);
const lookupError = ref("");

const team = computed(() => {
  const num = String(entryNum.value).trim();
  return isLookupEntryAvailable(entries.value, num) ? entries.value[num] : null;
});
const hasAnyWait = computed(() => Boolean(registrationWait.value) || queueEntries.value.length > 0);

function publicQueueFor(type) {
  return publicQueues.value.find((queue) => queue.type === type) || { entries: [], total: 0 };
}

function syncAllTimers() {
  for (const type of Object.keys(allBooths.value)) {
    syncTimers(allBooths.value[type] || [], type);
  }
}

async function loadEntries({ notify = false } = {}) {
  try {
    entries.value = await fetchEntries();
    return true;
  } catch {
    if (notify) error("엔트리 정보를 가져올 수 없습니다.");
    return false;
  }
}

async function loadPublicQueues({ notify = false } = {}) {
  try {
    const result = await fetchPublicQueues();
    publicQueues.value = Array.isArray(result.queues) ? result.queues : [];
  } catch {
    if (notify) error("전체 검차 대기열을 가져올 수 없습니다.");
  }
}

let notifyPublicQueueFailure = false;
const publicQueueRefresh = createCoalescedRefresh({
  refresh: () => {
    const notify = notifyPublicQueueFailure;
    notifyPublicQueueFailure = false;
    return loadPublicQueues({ notify });
  },
});

function requestPublicQueues({ notify = false } = {}) {
  notifyPublicQueueFailure ||= notify;
  return publicQueueRefresh.request();
}

function clearLookupState(message = "") {
  registrationWait.value = null;
  queueEntries.value = [];
  hasQueried.value = false;
  lastQueryNum.value = "";
  lookupError.value = message;
  sessionStorage.removeItem("queue_entry");
  refreshScheduler.markRefreshed();
}

async function loadLookup(num, { notify = false } = {}) {
  const [queueResult, registrationResult] = await Promise.allSettled([
    fetchQueueState(num),
    fetchRegistrationLookup(year, num),
  ]);

  if (queueResult.status === "rejected") {
    const message = queueResult.reason?.message || "검차 대기 순번을 새로고침할 수 없습니다.";
    if (isTerminalLookupError(queueResult.reason)) clearLookupState(message);
    else lookupError.value = "검차 대기 순번을 새로고침할 수 없습니다.";
    if (notify) error(queueResult.reason?.message || "대기 순번을 조회할 수 없습니다.");
    return false;
  }

  queueEntries.value = queueResult.value.queues || [];
  registrationWait.value = registrationResult.status === "fulfilled" ? registrationResult.value : null;
  lookupError.value = registrationResult.status === "rejected" && registrationResult.reason?.status !== 404
    ? "등록 대기 순번을 새로고침할 수 없습니다."
    : "";
  hasQueried.value = true;
  lastQueryNum.value = num;
  sessionStorage.setItem("queue_entry", num);
  return true;
}

async function refreshLookupNow() {
  if (!lastQueryNum.value) return;
  await loadLookup(lastQueryNum.value);
}

const refreshScheduler = createLookupRefreshScheduler({
  intervalMs: 10_000,
  refresh: refreshLookupNow,
});

async function query() {
  if (busy.value) return;
  const num = String(entryNum.value).trim();
  if (!num) {
    error("엔트리 번호를 입력하세요.");
    return;
  }
  if (!isLookupEntryAvailable(entries.value, num)) {
    error("존재하지 않는 엔트리 번호입니다.");
    return;
  }

  busy.value = true;
  lookupError.value = "";
  refreshScheduler.markRefreshed();
  try {
    await loadLookup(num, { notify: true });
  } finally {
    busy.value = false;
  }
}

function onEntryInput() {
  if (String(entryNum.value).trim() === lastQueryNum.value) return;
  clearLookupState();
}

function removeRetiredLookupCredentials() {
  sessionStorage.removeItem("queue_phone");
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith("fsk_registration_lookup_")) sessionStorage.removeItem(key);
  }
}

watch(lastBoothUpdate, syncAllTimers);
watch(allBooths, syncAllTimers, { deep: true });
watch(lastQueueUpdate, () => {
  requestPublicQueues();
  if (lastQueryNum.value) refreshScheduler.request();
});
watch(activeInspections, () => requestPublicQueues());
watch(registrationRevision, () => {
  if (lastQueryNum.value) refreshScheduler.request();
});
watch(lastEntriesUpdate, async () => {
  const queriedNum = lastQueryNum.value;
  const loaded = await loadEntries();
  requestPublicQueues();
  if (loaded && queriedNum && queriedNum === lastQueryNum.value
    && !isLookupEntryAvailable(entries.value, queriedNum)) {
    clearLookupState("엔트리 정보가 변경되어 이전 조회 결과를 지웠습니다.");
  }
});
watch(queueReconnected, () => {
  requestPublicQueues();
  if (lastQueryNum.value) refreshScheduler.request({ force: true });
});
watch(registrationReconnected, () => {
  if (lastQueryNum.value) refreshScheduler.request({ force: true });
});

onMounted(async () => {
  removeRetiredLookupCredentials();
  await Promise.allSettled([
    loadEntries({ notify: true }),
    requestPublicQueues({ notify: true }),
  ]);

  const savedEntry = sessionStorage.getItem("queue_entry");
  if (savedEntry) {
    entryNum.value = savedEntry;
    await query();
  }

  loading.value = false;
  syncAllTimers();
});

onUnmounted(() => {
  refreshScheduler.stop();
  publicQueueRefresh.stop();
});
</script>

<template>
  <div class="queue-status">
    <div class="status-grid">
      <section class="card query-card">
        <div class="card-header">
          <h3>🔍 통합 대기 순번 조회</h3>
        </div>
        <form class="card-body" @submit.prevent="query">
          <label class="form-label" for="queue-entry-number">엔트리 번호</label>
          <input
            id="queue-entry-number"
            v-model="entryNum"
            type="number"
            min="1"
            inputmode="numeric"
            autocomplete="off"
            class="form-input entry-input entry-only-input"
            placeholder="엔트리 번호"
            @input="onEntryInput"
          >
          <div class="team-display">
            <div v-if="team" class="team-badge">{{ team.univ }} {{ team.team }}</div>
            <div v-else-if="entryNum" class="team-badge error">존재하지 않는 엔트리</div>
            <div v-else class="team-badge placeholder">&nbsp;</div>
          </div>

          <button class="btn btn-primary btn-block" type="submit" :disabled="busy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            {{ busy ? "조회 중…" : "조회" }}
          </button>
        </form>
      </section>

      <section class="card result-card">
        <div class="card-header">
          <h3>📋 내 대기 현황</h3>
        </div>
        <div class="card-body result-body" aria-live="polite">
          <p v-if="lookupError" class="result-message">{{ lookupError }}</p>
          <div v-if="hasQueried && hasAnyWait" class="result-display">
            <div v-if="registrationWait" class="result-row result-row-detailed">
              <span class="result-name">등록</span>
              <span class="rank-stack">
                <span class="rank-line">
                  <strong class="result-rank">{{ registrationWait.position }}</strong>
                  <span class="result-suffix">번</span>
                  <span class="result-total">/ {{ registrationWait.waitingTotal }}팀</span>
                </span>
              </span>
            </div>
            <div v-for="queue in queueEntries" :key="queue.type" class="result-row result-row-detailed">
              <span class="result-name">{{ queue.name }}</span>
              <span class="rank-stack">
                <span class="rank-line">
                  <span class="overall-rank-label">전체</span>
                  <strong class="result-rank">{{ queue.rank }}</strong>
                  <span class="result-suffix">번</span>
                  <span class="result-total">/ {{ queue.total }}팀</span>
                </span>
                <span class="cohort-rank rank-line">
                  <span class="overall-rank-label">{{ queue.isReinspection ? "재검" : "초검" }}</span>
                  <strong class="result-rank">{{ queue.groupRank }}</strong>
                  <span class="result-suffix">번</span>
                  <span class="result-total">/ {{ queue.groupTotal }}팀</span>
                </span>
              </span>
            </div>
          </div>
          <p v-else-if="hasQueried && !lookupError" class="empty-result">현재 등록 또는 검차 대기가 없습니다.</p>
          <div v-else class="result-row placeholder"><strong class="result-rank">-</strong></div>
        </div>
      </section>
    </div>

    <section class="card queues-card">
      <div class="card-header">
        <h3>🛎️ 전체 대기열 현황</h3>
      </div>
      <div class="card-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
          <p>데이터를 불러오는 중...</p>
        </div>
        <div v-else-if="visibleInspections.length === 0" class="empty-state">
          현재 활성화된 검차가 없습니다.
        </div>
        <div v-else class="booth-sections">
          <section
            v-for="item in visibleInspections"
            :key="item.type"
            class="booth-type-section"
          >
            <div class="booth-type-header">
              <span class="booth-type-title">{{ item.name }}</span>
              <span class="badge badge-primary">{{ item.length }}팀 대기</span>
            </div>
            <div class="booth-grid">
              <div
                v-for="booth in (allBooths[item.type] || [])"
                :key="booth.booth_num"
                class="booth-item"
                :class="{
                  'booth-inactive': !booth.active,
                  'booth-occupied': booth.active && booth.occupied_by,
                  'booth-paused': booth.active && booth.timer_paused_at,
                }"
              >
                <div class="booth-num">{{ item.name }}{{ booth.booth_num }}</div>
                <div class="booth-status-body">
                  <template v-if="!booth.active">
                    <span class="booth-status-tag inactive">비활성</span>
                  </template>
                  <template v-else-if="booth.occupied_by">
                    <span v-if="booth.timer_paused_at" class="booth-status-tag paused">일시중단</span>
                    <span v-else class="booth-status-tag occupied">검차중</span>
                    <span class="booth-elapsed" :class="{ 'booth-elapsed-paused': booth.timer_paused_at }">
                      {{ elapsedTimes[`${item.type}-${booth.booth_num}`] || "00:00" }}
                    </span>
                  </template>
                  <template v-else>
                    <span class="booth-status-tag empty">입차 가능</span>
                  </template>
                </div>
              </div>
            </div>

            <details class="public-queue-disclosure">
              <summary>
                <span>대기 목록</span>
                <span class="public-queue-count">{{ publicQueueFor(item.type).total }}팀</span>
              </summary>
              <ol v-if="publicQueueFor(item.type).entries.length" class="public-queue-list">
                <li
                  v-for="queuedTeam in publicQueueFor(item.type).entries"
                  :key="queuedTeam.teamId"
                  class="public-queue-row"
                >
                  <div class="public-team-line" :title="`${queuedTeam.university} / ${queuedTeam.name}`">
                    <strong class="public-entry-number mono">#{{ queuedTeam.number }}</strong>
                    <span class="public-university">{{ queuedTeam.university }}</span>
                    <span class="public-team-name">{{ queuedTeam.name }}</span>
                  </div>
                  <div class="public-ranks">
                    <span>전체 <strong>{{ queuedTeam.rank }}번</strong></span>
                    <span aria-hidden="true">·</span>
                    <span :class="queuedTeam.isReinspection ? 'rank-reinspection' : 'rank-initial'">
                      {{ queuedTeam.isReinspection ? "재검" : "초검" }} <strong>{{ queuedTeam.groupRank }}번</strong>
                    </span>
                  </div>
                </li>
              </ol>
              <p v-else class="public-queue-empty">현재 대기 중인 팀이 없습니다.</p>
            </details>
          </section>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
.entry-only-input {
  width: 100%;
  text-align: center;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.empty-result {
  color: var(--text-secondary);
  font-weight: 600;
  text-align: center;
}

.result-row-detailed {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  width: min(100%, 24rem);
  align-items: center;
  gap: 0.75rem;
  font-size: 0.9375rem;
  line-height: 1.4;
}

.result-row-detailed .result-name,
.result-row-detailed .result-rank,
.result-row-detailed .result-suffix,
.result-row-detailed .result-total,
.result-row-detailed .overall-rank-label,
.result-row-detailed .cohort-rank {
  font-size: inherit;
  line-height: inherit;
}

.rank-stack {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.rank-line {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
  white-space: nowrap;
}

.overall-rank-label {
  color: var(--text-secondary);
  font-weight: 600;
}

.booth-sections {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.booth-type-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.booth-type-title {
  color: var(--text-primary);
  font-size: 1rem;
  font-weight: 600;
}

.booth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
}

.booth-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  padding: 0.875rem;
  text-align: center;
  background: var(--bg-card);
  border: 2px solid var(--border-color);
  border-radius: 10px;
}

.booth-status-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
}

.booth-item.booth-inactive {
  opacity: 0.5;
  background: var(--bg-secondary);
}

.booth-item.booth-occupied { border-color: var(--accent-warning, #f59e0b); }
.booth-item.booth-paused {
  background: rgba(239, 68, 68, 0.06);
  border-color: var(--accent-danger, #ef4444);
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.18);
}

.booth-num {
  color: var(--text-primary);
  font-size: 0.875rem;
  font-weight: 700;
}

.booth-status-tag {
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 6px;
}

.booth-status-tag.empty { color: var(--accent-success); background: rgba(16, 185, 129, 0.15); }
.booth-status-tag.occupied { color: var(--accent-warning, #f59e0b); background: rgba(245, 158, 11, 0.15); }
.booth-status-tag.paused { color: var(--accent-danger, #ef4444); background: rgba(239, 68, 68, 0.15); }
.booth-status-tag.inactive { color: var(--text-tertiary); background: var(--bg-secondary); }

.booth-elapsed {
  color: var(--accent-warning, #f59e0b);
  font-family: "JetBrains Mono", monospace;
  font-size: 1.125rem;
  font-weight: 700;
}

.booth-elapsed-paused { color: var(--accent-danger, #ef4444); }

.public-queue-disclosure {
  margin-top: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.public-queue-disclosure summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.public-queue-disclosure summary::-webkit-details-marker { display: none; }
.public-queue-disclosure summary::before {
  content: "▸";
  color: var(--text-tertiary);
  transition: transform 0.15s ease;
}
.public-queue-disclosure[open] summary::before { transform: rotate(90deg); }

.public-queue-count {
  margin-left: auto;
  color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
}

.public-queue-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-color);
}

.public-queue-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.125rem;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  border-bottom: 1px solid var(--border-color);
}

.public-queue-row:last-child { border-bottom: 0; }

.public-team-line {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  white-space: nowrap;
}

.public-entry-number {
  flex-shrink: 0;
}
.public-team-name,
.public-university {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-team-name {
  flex: 1;
  font-weight: 600;
}
.public-university {
  flex: 0 1 auto;
  max-width: 50%;
}

.public-ranks {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: inherit;
  white-space: nowrap;
}

.public-ranks strong { color: var(--text-primary); }
.public-ranks .rank-initial { color: var(--accent-success); }
.public-ranks .rank-reinspection { color: var(--accent-warning, #f59e0b); }
.public-ranks .rank-initial strong,
.public-ranks .rank-reinspection strong { color: inherit; }

.public-queue-empty {
  padding: 1rem;
  color: var(--text-secondary);
  text-align: center;
  border-top: 1px solid var(--border-color);
}

@media (max-width: 640px) {
  .booth-grid { grid-template-columns: repeat(2, 1fr); }
  .public-queue-row {
    padding: 0.4375rem 0.625rem;
  }
}
</style>
