<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { formatPhone } from "@shared/format-phone.js";
import { useNotification } from "@shared/useNotification.js";
import * as api from "../api.js";

const { success } = useNotification();
const year = ref(currentCompetitionYear());
const status = ref(null);
const number = ref("");
const phone = ref("010");
const agreed = ref(false);
const team = ref(null);
const teamError = ref("");
const checking = ref(false);
const error = ref("");
const busy = ref(false);

let lookupTimer = null;
let lookupSequence = 0;
let events = null;

async function loadStatus() {
  if (!year.value) return;
  try { status.value = await api.fetchStatus(year.value); }
  catch { status.value = null; }
}

async function checkTeam(value, sequence = ++lookupSequence) {
  const trimmed = String(value).trim();
  team.value = null;
  teamError.value = "";
  if (!trimmed || !year.value) {
    checking.value = false;
    return;
  }
  checking.value = true;
  try {
    const found = await api.fetchTeam(trimmed, year.value);
    if (sequence !== lookupSequence) return;
    team.value = found;
  } catch (requestError) {
    if (sequence !== lookupSequence) return;
    teamError.value = api.errorMessage(requestError);
  } finally {
    if (sequence === lookupSequence) checking.value = false;
  }
}

watch(number, (value) => {
  clearTimeout(lookupTimer);
  const sequence = ++lookupSequence;
  team.value = null;
  teamError.value = "";
  error.value = "";
  if (!String(value).trim()) {
    checking.value = false;
    return;
  }
  checking.value = true;
  lookupTimer = setTimeout(() => checkTeam(value, sequence), 250);
});

function onPhoneInput(event) {
  phone.value = formatPhone(event.target.value);
  error.value = "";
}

function reset() {
  clearTimeout(lookupTimer);
  lookupSequence += 1;
  number.value = "";
  phone.value = "010";
  agreed.value = false;
  team.value = null;
  teamError.value = "";
  checking.value = false;
  error.value = "";
}

async function submit() {
  if (busy.value) return;
  if (!team.value) {
    error.value = teamError.value || "활성 엔트리 번호를 입력하세요.";
    return;
  }
  if (team.value.queueStatus) {
    error.value = "이미 대기 중인 엔트리입니다.";
    return;
  }
  if (!/^010\d{8}$/.test(phone.value.replace(/\D/g, ""))) {
    error.value = "전화번호를 정확히 입력하세요.";
    return;
  }
  if (!agreed.value) {
    error.value = "개인정보 수집 및 이용에 동의하세요.";
    return;
  }

  busy.value = true;
  error.value = "";
  try {
    const created = await api.createRegistration({ teamId: team.value.id, phone: phone.value });
    await loadStatus();
    reset();
    success(`엔트리 ${created.number}번을 ${created.position}번째 대기로 등록했습니다.`);
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
    await checkTeam(number.value);
  } finally {
    busy.value = false;
  }
}

function startEvents() {
  events?.close();
  events = new EventSource(api.eventsUrl(year.value));
  const refresh = () => {
    loadStatus();
    if (number.value) checkTeam(number.value);
  };
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
}

onMounted(async () => {
  try {
    await loadStatus();
    startEvents();
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
  }
});

onUnmounted(() => {
  events?.close();
  clearTimeout(lookupTimer);
});
</script>

<template>
  <div class="kiosk-register">
    <div class="kiosk-content">
      <section class="card queue-overview">
        <div class="card-header"><h3>🛎️ 등록 대기열</h3></div>
        <div class="card-body overview-body">
          <div v-if="status" class="queue-state">
            <span class="badge" :class="status.open ? 'badge-success' : 'badge-danger'">
              {{ status.open ? "접수 중" : "접수 마감" }}
            </span>
            <strong><span class="mono">{{ status.waiting }}</span>팀 대기 중</strong>
            <p>{{ status.open ? "엔트리와 연락처를 입력해 대기열에 등록하세요." : "지금은 등록 대기 접수를 받지 않습니다." }}</p>
          </div>
        </div>
      </section>

      <section v-if="status && !status.open" class="card notice-card">
        <div class="card-body">
          <span class="notice-icon" aria-hidden="true">⏸️</span>
          <h3>등록 대기 접수가 마감되었습니다</h3>
          <p>등록 데스크의 안내를 따라주세요.</p>
        </div>
      </section>

      <form v-else class="input-section" @submit.prevent="submit">
        <div class="input-group">
          <div class="input-row">
            <div class="input-col">
              <label for="register-number">엔트리</label>
              <input
                id="register-number"
                v-model="number"
                class="kiosk-input entry-input mono"
                inputmode="numeric"
                autocomplete="off"
                placeholder="번호"
                autofocus
              >
            </div>
            <div class="input-col flex-1">
              <label for="register-phone">전화번호</label>
              <input
                id="register-phone"
                class="kiosk-input mono"
                type="tel"
                inputmode="numeric"
                maxlength="13"
                autocomplete="off"
                placeholder="010-0000-0000"
                :value="phone"
                @input="onPhoneInput"
              >
            </div>
          </div>
          <div class="team-result">
            <span v-if="checking" class="muted">엔트리 확인 중…</span>
            <template v-else-if="team">
              <div>
                <small>{{ team.university }}</small>
                <strong>{{ team.name }}</strong>
              </div>
              <span v-if="team.queueStatus" class="badge badge-warning">
                이미 대기 중
              </span>
              <span v-else class="badge badge-success">확인됨</span>
            </template>
            <span v-else-if="teamError" class="error-text">{{ teamError }}</span>
            <span v-else class="muted">번호를 입력하면 학교와 팀을 확인합니다.</span>
          </div>
        </div>

        <div class="agreement-group">
          <button
            type="button"
            class="consent-card"
            :class="{ agreed }"
            :aria-pressed="agreed"
            @click="agreed = !agreed; error = ''"
          >
            <span class="consent-check" aria-hidden="true">{{ agreed ? "✓" : "" }}</span>
            <span>
              <strong>개인정보 수집·이용 동의 (필수)</strong>
              <small>항목: 엔트리 번호·휴대전화번호</small>
              <small>목적: 등록 대기·순번 조회·사전 순번 안내</small>
              <small>보유: 운영 이력과 함께 별도 삭제 전까지 보관</small>
              <small>미동의 시 등록 대기 신청 불가</small>
            </span>
          </button>
        </div>

        <p v-if="error" class="error-text form-error">{{ error }}</p>
        <div class="submit-group">
          <button class="reset-button" type="button" :disabled="busy" @click="reset">초기화</button>
          <button class="submit-button" type="submit" :disabled="busy || !status?.open">
            {{ busy ? "등록 중…" : "대기 등록" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.kiosk-register { min-height: calc(100vh - 7rem); display: flex; flex-direction: column; }
.kiosk-content { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; flex: 1; }
.queue-overview { height: fit-content; }
.overview-body { display: flex; flex-direction: column; gap: 1.5rem; }
.queue-state { display: flex; flex-direction: column; align-items: flex-start; gap: 0.75rem; padding: 1rem; background: var(--bg-hover); border-radius: 10px; }
.queue-state strong { font-size: 1.5rem; }
.queue-state .mono { color: var(--accent-primary); font-size: 2.25rem; }
.queue-state p { color: var(--text-secondary); }
.input-section { display: flex; flex-direction: column; gap: 1.5rem; }
.input-group,
.agreement-group { padding: 1.5rem; background: var(--bg-card); border-radius: 12px; box-shadow: var(--shadow-card); }
.input-row { display: flex; gap: 1rem; }
.input-col { display: flex; flex-direction: column; }
.input-col.flex-1 { flex: 1; }
.input-col label { margin-bottom: 1rem; color: var(--text-secondary); font-size: 1.125rem; font-weight: 600; }
.kiosk-input { width: 100%; padding: 1.25rem 1.5rem; color: var(--text-primary); background: var(--bg-input); border: 2px solid var(--border-color); border-radius: 12px; font-size: 1.75rem; font-weight: 600; transition: border-color 0.2s ease, box-shadow 0.2s ease; }
.kiosk-input:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15); }
.kiosk-input::placeholder { color: var(--text-tertiary); font-weight: 400; }
.entry-input { width: 120px; text-align: center; }
.team-result { min-height: 3.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; padding: 0.875rem 1.25rem; background: var(--bg-hover); border-radius: 10px; }
.team-result div { display: flex; flex-direction: column; }
.team-result small { color: var(--text-secondary); }
.notice-card { align-self: start; width: 100%; text-align: center; }
.notice-card .card-body { padding: 3rem 2rem; }
.notice-card p { margin-top: 0.4rem; color: var(--text-secondary); }
.notice-icon { display: block; margin-bottom: 0.75rem; font-size: 2rem; }
.consent-card {
  display: flex;
  align-items: flex-start;
  gap: 0.9rem;
  width: 100%;
  padding: 1.25rem;
  color: var(--text-primary);
  text-align: left;
  background: var(--bg-secondary);
  border: 3px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
.consent-card:hover { border-color: var(--accent-primary); }
.consent-card.agreed { border-color: var(--accent-success); background: rgba(39, 166, 68, 0.07); }
.consent-card > span:last-child { display: flex; flex-direction: column; }
.consent-card small { color: var(--text-secondary); line-height: 1.55; }
.consent-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 2px solid var(--border-color);
  border-radius: 6px;
  color: white;
  background: var(--bg-input);
  font-weight: 700;
}
.agreed .consent-check { border-color: var(--accent-success); background: var(--accent-success); }
.form-error { margin: -0.75rem 0; text-align: center; }
.submit-group { display: grid; grid-template-columns: 1fr 2fr; gap: 1rem; margin-top: auto; }
.reset-button,
.submit-button { min-height: 4rem; padding: 1rem; border: 0; border-radius: 12px; font-size: 1.25rem; font-weight: 700; cursor: pointer; }
.reset-button { color: var(--text-secondary); background: var(--bg-card); box-shadow: var(--shadow-card); }
.submit-button { color: white; background: var(--accent-primary); }
.reset-button:disabled,
.submit-button:disabled { cursor: not-allowed; opacity: 0.5; }
@media (max-width: 900px) {
  .kiosk-content { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .input-row { flex-direction: column; }
  .entry-input { width: 100%; }
  .submit-group { grid-template-columns: 1fr; }
  .reset-button { order: 2; }
}
</style>
