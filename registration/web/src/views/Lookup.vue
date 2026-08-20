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

// 마지막으로 실제 조회한 자격증명. 접수 전 조회로 404 를 받았어도 유지해서,
// 데스크가 등록하면 SSE 갱신에서 순번이 저절로 뜨게 한다.
const lastQuery = ref(null);
// 공용 회선에서 여러 명이 화면을 열어두면 조회 rate limit(IP당 분당 60회)에
// 닿을 수 있으므로 자동 재조회에는 최소 간격을 둔다.
const REFRESH_INTERVAL_MS = 10_000;
let lastRefreshAt = 0;

const team = computed(() => teams.value[String(form.value.num).trim()] || null);
const storageKey = () => `fsk_registration_lookup_${year.value}`;

async function loadStatus() {
  if (!year.value) return;
  try { status.value = await api.fetchStatus(year.value); }
  catch { status.value = null; }
}

async function loadTeams() {
  try {
    teams.value = await api.fetchTeams(year.value);
    return true;
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
    return false;
  }
}

function onPhoneInput(event) {
  form.value.phone = formatPhone(event.target.value);
  error.value = "";
}

async function lookup() {
  const num = String(form.value.num).trim();
  const phone = String(form.value.phone).trim();
  if (!num || !phone) {
    result.value = null;
    notFound.value = false;
    lastQuery.value = null;
    error.value = "엔트리 번호와 전화번호를 입력하세요.";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    result.value = await api.lookupRegistration({ year: year.value, num, phone });
    notFound.value = false;
    lastQuery.value = { num, phone };
    lastRefreshAt = Date.now();
    localStorage.setItem(storageKey(), JSON.stringify({ num, phone }));
  } catch (requestError) {
    result.value = null;
    notFound.value = requestError?.status === 404;
    // 404 는 "아직 대기 내역이 없다"는 뜻이라 자격증명 자체는 다시 쓸 수 있다.
    lastQuery.value = notFound.value ? { num, phone } : null;
    lastRefreshAt = Date.now();
    error.value = api.errorMessage(requestError);
  } finally {
    busy.value = false;
  }
}

async function refreshLookup({ force = false } = {}) {
  const credentials = lastQuery.value;
  if (!credentials) return;
  const now = Date.now();
  if (!force && now - lastRefreshAt < REFRESH_INTERVAL_MS) return;
  lastRefreshAt = now;
  try {
    result.value = await api.lookupRegistration({ year: year.value, ...credentials });
    notFound.value = false;
    error.value = "";
  } catch (requestError) {
    result.value = null;
    notFound.value = requestError?.status === 404;
  }
}

function restoreLookup() {
  result.value = null;
  notFound.value = false;
  error.value = "";
  lastQuery.value = null;
  form.value = { num: "", phone: "010" };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
    if (saved?.num && saved?.phone) {
      form.value = { num: saved.num, phone: formatPhone(saved.phone) };
      lastQuery.value = { num: String(saved.num).trim(), phone: String(saved.phone).trim() };
      refreshLookup({ force: true });
    }
  } catch {}
}

function startEvents() {
  events?.close();
  if (!year.value) return;
  events = new EventSource(api.eventsUrl(year.value));
  const refresh = () => {
    loadStatus();
    refreshLookup();
  };
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
  // 정식 엔트리가 바뀌면 로스터를 다시 받는다(초기 로드가 실패했을 때의 복구 경로도 된다).
  events.addEventListener("entries", loadTeams);
}

onMounted(async () => {
  // 로스터 조회가 실패해도 SSE 와 저장된 조회 복원은 계속 진행한다. 실패한 로스터는
  // entries 이벤트에서 다시 받는다.
  await Promise.allSettled([loadTeams(), loadStatus()]);
  restoreLookup();
  startEvents();
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            {{ busy ? "조회 중…" : "조회" }}
          </button>
        </form>
      </section>

      <section class="card result-card">
        <div class="card-header"><h3>📋 실시간 대기 순번</h3></div>
        <div class="card-body result-body">
          <p v-if="notFound" class="result-message">대기 중인 등록 내역이 없습니다.</p>
          <p v-else-if="error" class="result-message">{{ error }}</p>
          <div v-else class="result-display">
            <div class="result-row" :class="{ placeholder: !result }">
              <strong class="result-rank">{{ result ? result.position : "-" }}</strong>
              <span v-if="result" class="result-suffix">번째</span>
              <span class="result-total">/ {{ status?.waiting ?? "-" }}팀</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
