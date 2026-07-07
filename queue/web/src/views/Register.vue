<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import QRCode from "qrcode";
import { fetchEntries, registerToQueue } from "../api";
import { useSSE } from "../composables/useSSE";
import { useNotification } from "@shared/useNotification.js";
import { useBoothTimers } from "../composables/useBoothTimers";
import { formatPhone } from "@shared/format-phone.js";

const router = useRouter();

const { success, error, warning } = useNotification();

const { activeInspections, allBooths, lastBoothUpdate } = useSSE();

const visibleInspections = computed(() =>
  activeInspections.value.filter((i) => !i.hidden_from_register),
);

const { elapsedTimes, syncTimers, clearAllTimers } = useBoothTimers();

const entries = ref({});
const loading = ref(true);

const entryNum = ref("");
const phone = ref("010");
const inspection = ref("");
const agreed = ref(false);

// 대기열 조회 페이지(QueueStatus, path "/") 절대 URL — 참가자가 휴대폰으로 순번 확인
const statusUrl = new URL(router.resolve("/").href, window.location.origin).href;
const qrDataUrl = ref("");

const currentEntry = computed(() => {
  if (!entryNum.value || !entries.value[entryNum.value]) return null;
  return entries.value[entryNum.value];
});

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;

  try {
    qrDataUrl.value = await QRCode.toDataURL(statusUrl, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (e) {
    qrDataUrl.value = "";
  }
});



function onPhoneInput(e) {
  phone.value = formatPhone(e.target.value);
}

const currentBooths = computed(() => {
  if (!inspection.value || !allBooths.value[inspection.value]) return [];
  return allBooths.value[inspection.value];
});

const inspectionName = computed(() => {
  const item = activeInspections.value.find((i) => i.type === inspection.value);
  return item ? item.name : "";
});

function selectInspection(type) {
  inspection.value = type;
  syncElapsedTimers();
}

function syncElapsedTimers() {
  syncTimers(currentBooths.value, inspection.value);
}

watch(lastBoothUpdate, (update) => {
  if (update && update.type === inspection.value) {
    syncElapsedTimers();
  }
});

async function submit() {
  const num = entryNum.value;
  const phoneDigits = phone.value.replace(/-/g, "");

  if (!num) {
    error("엔트리 번호를 입력하세요.");
    return;
  }

  if (!entries.value[num]) {
    error("존재하지 않는 엔트리 번호입니다.");
    return;
  }

  if (!phoneDigits) {
    error("전화번호를 입력하세요.");
    return;
  }

  if (!/^010\d{8}$/.test(phoneDigits)) {
    error("유효하지 않은 전화번호입니다.");
    return;
  }

  if (!inspection.value) {
    error("검차 종류를 선택하세요.");
    return;
  }

  if (!agreed.value) {
    error("개인정보 수집 및 이용에 동의해주세요.");
    return;
  }

  try {
    await registerToQueue(inspection.value, num, phoneDigits);
    success(`${num}번 엔트리가 등록되었습니다.`);

    // Reset form
    entryNum.value = "";
    phone.value = "010";
    inspection.value = "";
    agreed.value = false;
    clearAllTimers();
    elapsedTimes.value = {};
  } catch (e) {
    // 페널티 에러인 경우 로컬 시간으로 포맷
    try {
      const penalty = JSON.parse(e.message);
      if (penalty.until && penalty.remaining !== undefined) {
        const untilDate = new Date(penalty.until);
        const timeStr = untilDate.toLocaleTimeString("ko-KR");
        error(`취소 페널티 적용중입니다.\n${penalty.remaining}분 뒤 ${timeStr}에 해제됩니다.`);
        return;
      }
    } catch {
      // JSON 파싱 실패시 일반 에러 메시지
    }
    error(e.message);
  }
}

function resetForm() {
  entryNum.value = "";
  phone.value = "010";
  inspection.value = "";
  agreed.value = false;
  clearAllTimers();
  elapsedTimes.value = {};
  warning("입력이 초기화되었습니다.");
}
</script>

<template>
  <div class="kiosk-register">
    <div class="kiosk-content">
      <!-- Left: Inspection Selection -->
      <div class="inspection-section">
        <div class="inspection-group">
          <label>검차 종류 선택</label>
          <div class="inspection-grid">
            <button
              v-for="item in visibleInspections"
              :key="item.type"
              class="inspection-btn"
              :class="{ selected: inspection === item.type }"
              @click="selectInspection(item.type)"
            >
              <span class="inspection-name">{{ item.name }}</span>
              <span class="queue-length">{{ item.length }}팀 대기중</span>
            </button>
          </div>
          <div v-if="visibleInspections.length === 0" class="no-inspections">현재 활성화된 검차가 없습니다.</div>
        </div>

        <!-- Booth Status Cards -->
        <div v-if="inspection && currentBooths.length > 0" class="booth-status">
          <label>부스 현황</label>
          <div class="booth-cards">
            <div
              v-for="booth in currentBooths"
              :key="booth.booth_num"
              class="booth-card"
              :class="{ 'booth-inactive': !booth.active, 'booth-occupied': booth.active && booth.occupied_by }"
            >
              <div class="booth-card-num">{{ inspectionName }}{{ booth.booth_num }}</div>
              <div class="booth-card-body-content">
                <template v-if="!booth.active">
                  <div class="booth-card-status inactive">비활성</div>
                </template>
                <template v-else-if="booth.occupied_by">
                  <div class="booth-card-status occupied">검차중</div>
                  <div class="booth-card-elapsed">{{ elapsedTimes[`${inspection}-${booth.booth_num}`] || '00:00' }}</div>
                </template>
                <template v-else>
                  <div class="booth-card-status empty">입차 가능</div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Entry, Phone, Agreement & Submit -->
      <div class="input-section">
        <!-- Entry & Phone Number -->
        <div class="input-group">
          <div class="input-row">
            <div class="input-col">
              <label>엔트리</label>
              <input
                v-model="entryNum"
                type="number"
                inputmode="numeric"
                pattern="[0-9]*"
                class="kiosk-input entry-input"
                placeholder="번호"
              />
            </div>
            <div class="input-col flex-1">
              <label>전화번호</label>
              <input
                :value="phone"
                type="tel"
                inputmode="numeric"
                pattern="[0-9]*"
                class="kiosk-input"
                placeholder="010-0000-0000"
                maxlength="13"
                @input="onPhoneInput"
              />
            </div>
          </div>
          <div class="team-display-row">
            <div v-if="currentEntry" class="team-badge">{{ currentEntry.univ }} {{ currentEntry.team }}</div>
            <div v-else-if="entryNum && !currentEntry" class="team-badge error">존재하지 않는 엔트리</div>
            <div v-else class="team-badge placeholder">&nbsp;</div>
          </div>
        </div>

        <!-- Agreement -->
        <div class="agreement-group">
          <button class="agreement-btn" :class="{ agreed }" @click="agreed = !agreed">
            <span class="checkbox">
              <svg
                v-if="agreed"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                width="24"
                height="24"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span class="agreement-text">
              <strong>개인정보 수집 및 이용에 동의합니다</strong>
              <small>전화번호는 대기 순번 안내에만 사용되며, 입장 시 삭제됩니다.</small>
            </span>
          </button>
        </div>

        <!-- Action Buttons -->
        <div class="submit-group">
          <button class="reset-btn" @click="resetForm">초기화</button>
          <button class="submit-btn" @click="submit" :disabled="loading">등록하기</button>
        </div>

        <!-- Queue Status QR -->
        <div v-if="qrDataUrl" class="qr-card">
          <img class="qr-image" :src="qrDataUrl" alt="대기열 조회 QR 코드" />
          <div class="qr-text">
            <strong>내 순번 조회</strong>
            <small>QR을 스캔하면 휴대폰에서 실시간 대기 현황을 볼 수 있습니다.</small>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kiosk-register {
  min-height: calc(100vh - 4rem);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.kiosk-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  flex: 1;
}

/* Inspection Section (Left) */
.inspection-section {
  display: flex;
  flex-direction: column;
}

/* Input Section (Right) */
.input-section {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.input-group {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: var(--shadow-card);
}

.input-group label {
  display: block;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 1rem;
}

.kiosk-input {
  width: 100%;
  padding: 1.25rem 1.5rem;
  font-size: 1.75rem;
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  border: 2px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: all 0.2s ease;
}

.kiosk-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 4px rgba(94, 106, 210, 0.15);
}

.kiosk-input::placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}

/* Hide number input spinners */
.kiosk-input::-webkit-outer-spin-button,
.kiosk-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.kiosk-input[type="number"] {
  -moz-appearance: textfield;
}

.input-row {
  display: flex;
  gap: 1rem;
}

.input-col {
  display: flex;
  flex-direction: column;
}

.input-col.flex-1 {
  flex: 1;
}

.entry-input {
  width: 120px;
  text-align: center;
}

.team-display-row {
  margin-top: 1rem;
  min-height: 3.5rem;
}

.team-badge {
  display: block;
  background: var(--accent-primary);
  color: white;
  padding: 0.875rem 1.25rem;
  border-radius: 10px;
  font-size: 1.125rem;
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

.inspection-group {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: var(--shadow-card);
}

.inspection-group label {
  display: block;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 1rem;
}

.inspection-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}

.inspection-btn {
  padding: 1.5rem;
  border: 3px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.inspection-btn:hover {
  border-color: var(--accent-primary);
  background: rgba(94, 106, 210, 0.05);
}

.inspection-btn.selected {
  border-color: var(--accent-primary);
  background: rgba(94, 106, 210, 0.15);
}

.inspection-name {
  display: block;
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.inspection-btn.selected .inspection-name {
  color: var(--accent-primary);
}

.queue-length {
  display: block;
  font-size: 1rem;
  color: var(--text-tertiary);
}

.inspection-btn.selected .queue-length {
  color: var(--accent-primary);
}

.no-inspections {
  text-align: center;
  padding: 2rem;
  color: var(--text-tertiary);
  font-size: 1rem;
}

/* Agreement */
.agreement-group {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 1rem;
  box-shadow: var(--shadow-card);
}

.agreement-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 1.25rem;
  border: 3px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
}

.agreement-btn:hover {
  border-color: var(--accent-primary);
}

.agreement-btn.agreed {
  border-color: var(--accent-success);
  background: rgba(16, 185, 129, 0.1);
}

.checkbox {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.agreement-btn.agreed .checkbox {
  background: var(--accent-success);
  border-color: var(--accent-success);
  color: white;
}

.agreement-text {
  flex: 1;
}

.agreement-text strong {
  display: block;
  font-size: 1.125rem;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.agreement-text small {
  display: block;
  font-size: 0.9375rem;
  font-weight: 400;
  color: var(--text-tertiary);
}

/* Submit */
.submit-group {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 1rem;
}

.reset-btn,
.submit-btn {
  padding: 1.5rem;
  border: none;
  border-radius: 12px;
  font-size: 1.5rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reset-btn {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 3px solid var(--border-color);
}

.reset-btn:hover {
  background: var(--bg-hover);
}

.reset-btn:active {
  transform: scale(0.98);
}

.submit-btn {
  background: var(--accent-primary);
  color: white;
  box-shadow: 0 4px 20px rgba(94, 106, 210, 0.4);
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 25px rgba(94, 106, 210, 0.5);
}

.submit-btn:active:not(:disabled) {
  transform: translateY(0);
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Queue Status QR */
.qr-card {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  background: var(--bg-card);
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: var(--shadow-card);
}

.qr-image {
  width: 140px;
  height: 140px;
  flex-shrink: 0;
  border-radius: 10px;
  background: #ffffff;
  padding: 0.5rem;
}

.qr-text {
  flex: 1;
}

.qr-text strong {
  display: block;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
}

.qr-text small {
  display: block;
  font-size: 0.9375rem;
  font-weight: 400;
  line-height: 1.5;
  color: var(--text-tertiary);
}

@media (max-width: 600px) {
  .qr-card {
    flex-direction: column;
    text-align: center;
  }
}

/* Booth Status */
.booth-status {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: var(--shadow-card);
  margin-top: 1rem;
}

.booth-status label {
  display: block;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 1rem;
}

.booth-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.booth-card {
  flex: 1 1 120px;
  border: 3px solid var(--border-color);
  border-radius: 12px;
  padding: 1.25rem;
  background: var(--bg-secondary);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.booth-card-body-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.booth-card.booth-inactive {
  background: var(--bg-tertiary, var(--bg-secondary));
  opacity: 0.5;
}

.booth-card.booth-occupied {
  border-color: var(--accent-warning, #f59e0b);
}

.booth-card-num {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}

.booth-card-status {
  font-size: 1rem;
  font-weight: 600;
  padding: 0.25rem 0.75rem;
  border-radius: 8px;
}

.booth-card-status.empty {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}

.booth-card-status.occupied {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning, #f59e0b);
}

.booth-card-status.inactive {
  background: var(--bg-secondary);
  color: var(--text-tertiary);
}

.booth-card-elapsed {
  font-size: 1.75rem;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  color: var(--accent-warning, #f59e0b);
}

/* Responsive */
@media (max-width: 900px) {
  .kiosk-content {
    grid-template-columns: 1fr;
  }

  .inspection-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 600px) {
  .inspection-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .booth-cards {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
  }

  .kiosk-input {
    font-size: 1.5rem;
    padding: 1rem 1.25rem;
  }

  .inspection-name {
    font-size: 1.25rem;
  }

  .reset-btn,
  .submit-btn {
    font-size: 1.25rem;
    padding: 1.25rem;
  }
}
</style>
