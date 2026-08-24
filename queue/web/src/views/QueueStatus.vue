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

const queueEntries = ref([]);

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

    queueEntries.value = result.queues || [];

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
  queueEntries.value = [];
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

          <button class="btn btn-primary btn-block" @click="query">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
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
              <div v-for="e in queueEntries" :key="e.type" class="result-row">
                <span class="result-name">{{ e.name }}</span>
                <strong class="result-rank">{{ e.rank }}</strong>
                <span class="result-suffix">번</span>
                <span class="result-total">/ {{ e.total }}팀</span>
              </div>
            </template>
            <div v-else class="result-row placeholder"><strong class="result-rank">-</strong></div>
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
/* 조회 카드·팀 라벨·실시간 순번 규칙은 shared/styles/lookup-status.css 가 소유한다
   (등록 대기열 화면과 공유). 이 블록은 이 화면에만 있는 부스 현황 스타일이다. */
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
  .booth-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
