<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { fetchEntries, fetchQueueState } from "../api";
import { useSSE } from "../composables/useSSE";
import { useNotification } from "@shared/useNotification.js";
import { useBoothTimers } from "../composables/useBoothTimers";
import { formatPhone } from "@shared/format-phone.js";

const { error } = useNotification();

const { activeInspections, lastQueueUpdate, allBooths, lastBoothUpdate, lastEntriesUpdate } = useSSE();

const visibleInspections = computed(() =>
  activeInspections.value.filter((i) => !i.hidden_from_register),
);

const { elapsedTimes, syncTimers } = useBoothTimers();

function syncAllTimers() {
  for (const type of Object.keys(allBooths.value)) {
    syncTimers(allBooths.value[type] || [], type);
  }
}

watch(lastBoothUpdate, () => {
  syncAllTimers();
});

watch(allBooths, () => {
  syncAllTimers();
}, { deep: true });

const entries = ref({});
const loading = ref(true);

const entryNum = ref("");
const phone = ref("010");
const teamName = ref("");

const queueName = ref("-");
const rank = ref("-");

const queueEntries = computed(() => {
  if (queueName.value === "-") return [];
  const names = String(queueName.value).split(", ");
  const ranks = String(rank.value).split(", ");
  return names.map((name, i) => ({ name, rank: ranks[i] }));
});

// Watch for queue updates from SSE to refresh user's rank
watch(lastQueueUpdate, async () => {
  if (sessionStorage.getItem("queue_entry")) {
    await query();
  }
});

watch(lastEntriesUpdate, async () => {
  try {
    entries.value = await fetchEntries();
    updateTeamName();
  } catch {
    error("엔트리 정보를 새로고침할 수 없습니다.");
  }
});

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
  } catch (e) {
    error("엔트리 정보를 가져올 수 없습니다.");
  }

  // Restore saved state
  const savedEntry = sessionStorage.getItem("queue_entry");
  const savedPhone = sessionStorage.getItem("queue_phone");
  if (savedEntry && savedPhone) {
    entryNum.value = savedEntry;
    phone.value = formatPhone(savedPhone);
    updateTeamName();
    await query();
  }

  loading.value = false;
  syncAllTimers();
});

function updateTeamName() {
  const entry = entries.value[entryNum.value];
  if (entry) {
    teamName.value = `${entry.univ} ${entry.team}`;
  } else {
    teamName.value = "";
  }
}



function onPhoneInput(e) {
  phone.value = formatPhone(e.target.value);
}

async function query() {
  const num = entryNum.value;
  const phoneDigits = phone.value.replace(/-/g, "");

  if (!num) {
    clearState("엔트리 번호를 입력하세요.");
    return;
  }

  if (!entries.value[num]) {
    clearState("존재하지 않는 엔트리 번호입니다.");
    return;
  }

  if (!phoneDigits) {
    clearState("전화번호를 입력하세요.");
    return;
  }

  if (!/^010\d{8}$/.test(phoneDigits)) {
    clearState("유효하지 않은 전화번호입니다.");
    return;
  }

  try {
    const result = await fetchQueueState(num, phoneDigits);

    if (result.rank === -1) {
      clearState("대기중인 검차가 없습니다.");
      return;
    }

    queueName.value = result.queue;
    rank.value = result.rank;

    sessionStorage.setItem("queue_entry", num);
    sessionStorage.setItem("queue_phone", phoneDigits);
  } catch (e) {
    clearState(e.message);
  }
}

function clearState(message) {
  if (message) {
    error(message);
  }
  queueName.value = "-";
  rank.value = "-";
  phone.value = "010";
  sessionStorage.removeItem("queue_entry");
  sessionStorage.removeItem("queue_phone");
}
</script>

<template>
  <div class="queue-status">
    <div class="status-grid">
      <!-- Query Section -->
      <div class="card query-card">
        <div class="card-header">
          <h3>🔍 대기 순번 조회</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <div class="input-row">
              <div class="input-col">
                <label class="form-label">엔트리</label>
                <input
                  v-model="entryNum"
                  type="number"
                  class="form-input entry-input"
                  placeholder="번호"
                  @input="updateTeamName"
                />
              </div>
              <div class="input-col flex-1">
                <label class="form-label">전화번호</label>
                <input
                  :value="phone"
                  type="tel"
                  class="form-input"
                  placeholder="010-0000-0000"
                  maxlength="13"
                  @input="onPhoneInput"
                />
              </div>
            </div>
            <div class="team-display">
              <div v-if="teamName" class="team-badge">{{ teamName }}</div>
              <div v-else-if="entryNum && !entries[entryNum]" class="team-badge error">존재하지 않는 엔트리</div>
              <div v-else class="team-badge placeholder">&nbsp;</div>
            </div>
          </div>

          <button class="btn btn-primary btn-block" @click="query">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            조회
          </button>
        </div>
      </div>

      <!-- Result Section -->
      <div class="card result-card">
        <div class="card-header">
          <h3>📋 실시간 대기 순번</h3>
        </div>
        <div class="card-body result-body">
          <div class="result-display">
            <template v-if="queueEntries.length > 0">
              <div v-for="(e, i) in queueEntries" :key="i" class="result-row">
                <span>{{ e.name }}</span>
                <span class="result-rank">{{ e.rank }}</span>
                <span>번</span>
              </div>
            </template>
            <span v-else>-</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Active Queues & Booth Status -->
    <div class="card queues-card">
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
        <template v-else>
          <div class="booth-sections">
            <div
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
                  :class="{ 'booth-inactive': !booth.active, 'booth-occupied': booth.active && booth.occupied_by }"
                >
                  <div class="booth-num">{{ item.name }}{{ booth.booth_num }}</div>
                  <div class="booth-status-body">
                    <template v-if="!booth.active">
                      <span class="booth-status-tag inactive">비활성</span>
                    </template>
                    <template v-else-if="booth.occupied_by">
                      <span class="booth-status-tag occupied">검차중</span>
                      <span class="booth-elapsed">{{ elapsedTimes[`${item.type}-${booth.booth_num}`] || '00:00' }}</span>
                    </template>
                    <template v-else>
                      <span class="booth-status-tag empty">입차 가능</span>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Tips -->
    <div class="tips">
      <p>전화번호는 등록 시 입력한 알림 받을 번호입니다.</p>
      <p>내 순번은 대기열 변동 시 자동으로 업데이트됩니다.</p>
    </div>
  </div>
</template>

<style scoped>
.queue-status {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
}

.btn-block {
  width: 100%;
  margin-top: 1rem;
}

.input-row {
  display: flex;
  gap: 0.75rem;
}

.input-col {
  display: flex;
  flex-direction: column;
}

.input-col.flex-1 {
  flex: 1;
}

.entry-input {
  width: 5rem;
  text-align: center;
}

.input-col.flex-1 .form-input {
  text-align: center;
}

/* Hide number input spinners */
.entry-input::-webkit-outer-spin-button,
.entry-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.entry-input[type="number"] {
  -moz-appearance: textfield;
}

.team-display {
  margin-top: 0.75rem;
  min-height: 2.5rem;
}

.team-badge {
  padding: 0.5rem 1rem;
  background: var(--accent-primary);
  color: white;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  text-align: center;
}

.team-badge.error {
  background: var(--accent-danger);
  font-weight: 500;
}

.team-badge.placeholder {
  background: transparent;
  visibility: hidden;
}

.result-card {
  display: flex;
  flex-direction: column;
}

.result-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1rem;
}

.result-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 1.25rem;
  font-weight: 600;
  gap: 0.25rem;
}

.result-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
}

.result-rank {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--accent-primary);
  margin-left: 0.5rem;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.tips {
  padding: 1rem 1.25rem;
  background: var(--bg-secondary);
  border-radius: 12px;
  border-left: 4px solid var(--accent-primary);
}

.tips p {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0.25rem 0;
}

/* Booth Sections */
.booth-sections {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  margin-top: 1.25rem;
}

.booth-type-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.booth-type-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

/* Booth Grid */
.booth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
}

.booth-item {
  border: 2px solid var(--border-color);
  border-radius: 10px;
  padding: 0.875rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  background: var(--bg-card);
}

.booth-status-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
}

.booth-item.booth-inactive {
  opacity: 0.5;
  background: var(--bg-secondary);
}

.booth-item.booth-occupied {
  border-color: var(--accent-warning, #f59e0b);
}

.booth-num {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--text-primary);
}

.booth-status-tag {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 6px;
}

.booth-status-tag.empty {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}

.booth-status-tag.occupied {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning, #f59e0b);
}

.booth-status-tag.inactive {
  background: var(--bg-secondary);
  color: var(--text-tertiary);
}

.booth-elapsed {
  font-size: 1.125rem;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  color: var(--accent-warning, #f59e0b);
}

@media (max-width: 640px) {
  .status-grid {
    grid-template-columns: 1fr;
  }

  .booth-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
