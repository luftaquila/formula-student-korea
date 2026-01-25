<script setup>
import { ref, onMounted, watch } from "vue";
import { fetchEntries, fetchQueueState } from "../api";
import { useSSE } from "../composables/useSSE";
import { useNotification } from "../composables/useNotification";

const { error } = useNotification();

const { activeInspections, lastQueueUpdate } = useSSE();

const entries = ref({});
const loading = ref(true);

const entryNum = ref("");
const phone = ref("010");
const teamName = ref("");

const queueName = ref("-");
const rank = ref("-");

// Watch for queue updates from SSE to refresh user's rank
watch(lastQueueUpdate, async () => {
  if (localStorage.getItem("queue_entry")) {
    await query();
  }
});

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
  } catch (e) {
    error("엔트리 정보를 가져올 수 없습니다.");
  }

  // Restore saved state
  const savedEntry = localStorage.getItem("queue_entry");
  const savedPhone = localStorage.getItem("queue_phone");
  if (savedEntry && savedPhone) {
    entryNum.value = savedEntry;
    phone.value = formatPhone(savedPhone);
    updateTeamName();
    await query();
  }

  loading.value = false;
});

function updateTeamName() {
  const entry = entries.value[entryNum.value];
  if (entry) {
    teamName.value = `${entry.univ} ${entry.team}`;
  } else {
    teamName.value = "";
  }
}

function formatPhone(value) {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
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

    localStorage.setItem("queue_entry", num);
    localStorage.setItem("queue_phone", phoneDigits);
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
  localStorage.removeItem("queue_entry");
  localStorage.removeItem("queue_phone");
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
            <template v-if="queueName !== '-'">
              <span>{{ queueName }} 검차</span>
              <span class="result-rank">{{ rank }}</span>
              <span>번</span>
            </template>
            <span v-else>-</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Active Queues -->
    <div class="card queues-card">
      <div class="card-header">
        <h3>🛎️ 전체 대기열 현황</h3>
      </div>
      <div class="card-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
          <p>데이터를 불러오는 중...</p>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>검차 종류</th>
              <th>대기 팀 수</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in activeInspections" :key="item.type">
              <td>{{ item.name }}</td>
              <td>
                <span class="badge badge-primary">{{ item.length }} 팀</span>
              </td>
            </tr>
            <tr v-if="activeInspections.length === 0">
              <td colspan="2" class="empty-state">현재 활성화된 검차가 없습니다.</td>
            </tr>
          </tbody>
        </table>
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
  align-items: baseline;
  justify-content: center;
  font-size: 1.25rem;
  font-weight: 600;
}

.result-rank {
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

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 0.5rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
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

@media (max-width: 640px) {
  .status-grid {
    grid-template-columns: 1fr;
  }
}
</style>
