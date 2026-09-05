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
import { createLookupRefreshScheduler } from "../lookup-refresh.js";

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

const team = computed(() => entries.value[String(entryNum.value).trim()] || null);
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
  } catch {
    if (notify) error("엔트리 정보를 가져올 수 없습니다.");
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

async function loadLookup(num, { notify = false } = {}) {
  const [queueResult, registrationResult] = await Promise.allSettled([
    fetchQueueState(num),
    fetchRegistrationLookup(year, num),
  ]);

  if (queueResult.status === "rejected") {
    lookupError.value = "검차 대기 순번을 새로고침할 수 없습니다.";
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
  if (!entries.value[num]) {
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
  hasQueried.value = false;
  registrationWait.value = null;
  queueEntries.value = [];
  lookupError.value = "";
  lastQueryNum.value = "";
  sessionStorage.removeItem("queue_entry");
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
  loadPublicQueues();
  if (lastQueryNum.value) refreshScheduler.request();
});
watch(activeInspections, () => loadPublicQueues());
watch(registrationRevision, () => {
  if (lastQueryNum.value) refreshScheduler.request();
});
watch(lastEntriesUpdate, () => {
  loadEntries();
  loadPublicQueues();
});
watch(queueReconnected, () => {
  loadPublicQueues();
  if (lastQueryNum.value) refreshScheduler.request({ force: true });
});
watch(registrationReconnected, () => {
  if (lastQueryNum.value) refreshScheduler.request({ force: true });
});

onMounted(async () => {
  removeRetiredLookupCredentials();
  await Promise.allSettled([
    loadEntries({ notify: true }),
    loadPublicQueues({ notify: true }),
  ]);

  const savedEntry = sessionStorage.getItem("queue_entry");
  if (savedEntry) {
    entryNum.value = savedEntry;
    await query();
  }

  loading.value = false;
  syncAllTimers();
});

onUnmounted(() => refreshScheduler.stop());
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
              <span class="result-name">등록 대기</span>
              <strong class="result-rank">{{ registrationWait.position }}</strong>
              <span class="result-suffix">번</span>
              <span class="result-total">/ {{ registrationWait.waitingTotal }}팀</span>
            </div>
            <div v-for="queue in queueEntries" :key="queue.type" class="result-row result-row-detailed">
              <span class="result-name">{{ queue.name }}</span>
              <span class="overall-rank-label">전체</span>
              <strong class="result-rank">{{ queue.rank }}</strong>
              <span class="result-suffix">번</span>
              <span class="result-total">/ {{ queue.total }}팀</span>
              <span class="cohort-rank">
                {{ queue.isReinspection ? "재검" : "초검" }} {{ queue.groupRank }}위 / {{ queue.groupTotal }}팀
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
              <div v-if="publicQueueFor(item.type).entries.length" class="public-queue-table-wrap">
                <table class="public-queue-table">
                  <thead>
                    <tr>
                      <th scope="col">전체 순위</th>
                      <th scope="col">초검/재검 순위</th>
                      <th scope="col">엔트리</th>
                      <th scope="col">학교 / 팀</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="queuedTeam in publicQueueFor(item.type).entries" :key="queuedTeam.teamId">
                      <td class="mono">{{ queuedTeam.rank }}위</td>
                      <td>
                        <span class="badge" :class="queuedTeam.isReinspection ? 'badge-warning' : 'badge-success'">
                          {{ queuedTeam.isReinspection ? "재검" : "초검" }}
                        </span>
                        <span class="cohort-cell mono">{{ queuedTeam.groupRank }}위 / {{ queuedTeam.groupTotal }}팀</span>
                      </td>
                      <td class="mono">#{{ queuedTeam.number }}</td>
                      <td>{{ queuedTeam.university }} / {{ queuedTeam.name }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="public-queue-empty">현재 대기 중인 팀이 없습니다.</p>
            </details>
          </section>
        </div>
      </div>
    </section>

    <div class="tips">
      <p>엔트리 번호만 입력하면 등록 및 검차 대기 순번을 한 번에 확인할 수 있습니다.</p>
      <p>전화번호는 등록 대기·검차 대기 신청 시 문자 알림을 받을 번호로만 수집합니다.</p>
      <p>내 순번과 공개 검차 대기열은 대기열 변동 시 자동으로 업데이트됩니다.</p>
    </div>
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
  flex-wrap: wrap;
  justify-content: center;
}

.cohort-rank {
  flex-basis: 100%;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  text-align: center;
}

.overall-rank-label {
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.tips {
  padding: 1rem 1.25rem;
  background: var(--bg-secondary);
  border-left: 4px solid var(--accent-primary);
  border-radius: 12px;
}

.tips p {
  margin: 0.25rem 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
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

.public-queue-table-wrap {
  overflow-x: auto;
  border-top: 1px solid var(--border-color);
}

.public-queue-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.public-queue-table th,
.public-queue-table td {
  padding: 0.625rem 0.75rem;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
}

.public-queue-table th {
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-weight: 600;
}

.public-queue-table tbody tr:last-child td { border-bottom: 0; }
.cohort-cell { margin-left: 0.375rem; }
.public-queue-empty {
  padding: 1rem;
  color: var(--text-secondary);
  text-align: center;
  border-top: 1px solid var(--border-color);
}

@media (max-width: 640px) {
  .booth-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
