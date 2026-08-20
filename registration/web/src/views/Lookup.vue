<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { formatPhone } from "@shared/format-phone.js";
import * as api from "../api.js";

const year = ref(currentCompetitionYear());
const status = ref(null);
const teams = ref({});
const form = ref({ num: "", phone: "010" });
const result = ref(null);
const notFound = ref(false);
const error = ref("");
const busy = ref(false);
let events = null;

const team = computed(() => teams.value[String(form.value.num).trim()] || null);
const storageKey = () => `fsk_registration_lookup_${year.value}`;

async function loadStatus() {
  if (!year.value) return;
  try { status.value = await api.fetchStatus(year.value); }
  catch { status.value = null; }
}

function onPhoneInput(event) {
  form.value.phone = formatPhone(event.target.value);
  error.value = "";
}

async function lookup({ silent = false } = {}) {
  const num = String(form.value.num).trim();
  const phone = String(form.value.phone).trim();
  if (!num || !phone) {
    if (!silent) {
      result.value = null;
      notFound.value = false;
      error.value = "엔트리 번호와 전화번호를 입력하세요.";
    }
    return;
  }
  if (!silent) busy.value = true;
  error.value = "";
  try {
    result.value = await api.lookupRegistration({ year: year.value, num, phone });
    notFound.value = false;
    localStorage.setItem(storageKey(), JSON.stringify({ num, phone }));
  } catch (requestError) {
    result.value = null;
    notFound.value = requestError?.status === 404;
    if (!silent) error.value = api.errorMessage(requestError);
  } finally {
    if (!silent) busy.value = false;
  }
}

function restoreLookup() {
  result.value = null;
  notFound.value = false;
  error.value = "";
  form.value = { num: "", phone: "010" };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
    if (saved?.num && saved?.phone) {
      form.value = { num: saved.num, phone: formatPhone(saved.phone) };
      lookup({ silent: true });
    }
  } catch {}
}

function startEvents() {
  events?.close();
  if (!year.value) return;
  events = new EventSource(api.eventsUrl(year.value));
  const refresh = () => {
    loadStatus();
    if (result.value) lookup({ silent: true });
  };
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
}

onMounted(async () => {
  try {
    [teams.value] = await Promise.all([
      api.fetchTeams(year.value),
      loadStatus(),
    ]);
    restoreLookup();
    startEvents();
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
  }
});

onUnmounted(() => events?.close());
</script>

<template>
  <div class="queue-status">
    <div class="status-grid">
      <section class="card query-card">
        <div class="card-header">
          <h3>🔍 대기 순번 조회</h3>
        </div>
        <form class="card-body" @submit.prevent="lookup()">
          <div class="input-row">
            <div class="input-col">
              <label class="form-label" for="lookup-number">엔트리</label>
              <input
                id="lookup-number"
                v-model="form.num"
                type="number"
                class="form-input entry-input mono"
                inputmode="numeric"
                autocomplete="off"
                placeholder="번호"
              >
            </div>
            <div class="input-col flex-1">
              <label class="form-label" for="lookup-phone">전화번호</label>
              <input
                id="lookup-phone"
                class="form-input mono"
                type="tel"
                inputmode="numeric"
                maxlength="13"
                placeholder="010-0000-0000"
                autocomplete="tel"
                :value="form.phone"
                @input="onPhoneInput"
              >
            </div>
          </div>
          <div class="team-display">
            <div v-if="team" class="team-badge">{{ team.univ }} {{ team.team }}</div>
            <div v-else-if="form.num" class="team-badge error">존재하지 않는 엔트리</div>
            <div v-else class="team-badge placeholder">&nbsp;</div>
          </div>
          <button class="btn btn-primary btn-block" type="submit" :disabled="busy">
            {{ busy ? "조회 중…" : "내 순번 조회" }}
          </button>
        </form>
      </section>

      <section class="card result-card">
        <div class="card-header"><h3>📋 실시간 대기 순번</h3></div>
        <div class="card-body result-body">
          <p v-if="notFound" class="result-message">대기 중인 등록 내역이 없습니다.</p>
          <p v-else-if="error" class="result-message">{{ error }}</p>
          <div v-else class="rank-block" :class="{ placeholder: !result }">
            <strong class="mono">{{ result ? result.position : "-" }}</strong>
            <span v-if="result">번째</span>
            <span class="result-total">/ <span class="mono">{{ status?.waiting ?? "-" }}</span>팀</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.queue-status { display: flex; flex-direction: column; gap: 1.5rem; }
.status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
.input-row { display: flex; gap: 0.75rem; }
.input-col { display: flex; flex-direction: column; }
.input-col.flex-1 { flex: 1; }
.entry-input { width: 5rem; text-align: center; }
.input-col.flex-1 .form-input { text-align: center; }
.team-display { margin-top: 0.75rem; min-height: 2.5rem; }
.team-badge { padding: 0.5rem 1rem; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 6px; color: var(--accent-primary); font-size: 0.875rem; font-weight: 600; text-align: center; }
.team-badge.error { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.3); color: var(--accent-danger); font-weight: 500; }
.team-badge.placeholder { background: transparent; border-color: transparent; visibility: hidden; }
.btn-block { width: 100%; margin-top: 1rem; }
.result-card { display: flex; flex-direction: column; }
.result-body { display: flex; flex: 1; min-height: 9rem; flex-direction: column; justify-content: center; gap: 1rem; }
.result-message { color: var(--accent-danger); font-weight: 600; text-align: center; }
.rank-block { text-align: center; }
.rank-block strong { font-size: 3.3rem; line-height: 1; color: var(--accent-primary); }
.rank-block > span { margin-left: 0.3rem; font-size: 1.1rem; font-weight: 600; }
.rank-block.placeholder strong { color: var(--text-tertiary); }
.result-total { color: var(--text-secondary); font-weight: 500; }
</style>
