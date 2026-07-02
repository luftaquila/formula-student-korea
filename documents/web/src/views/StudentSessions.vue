<script setup>
import { ref, onMounted, computed } from "vue";
import { request, fetchEntries } from "../api.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";
import { formatDate } from "@shared/format-date.js";

const loading = ref(true);
const team = ref(null);
const sessions = ref([]);
const entries = ref({});

async function load() {
  loading.value = true;
  try {
    const res = await request("/api/sessions");
    const data = await res.json();
    team.value = data.team;
    sessions.value = data.sessions;
    if (team.value) {
      entries.value = await fetchEntries(team.value.year);
    }
  } catch { /* redirect handled by api */ }
  finally { loading.value = false; }
}

const teamEntry = computed(() => {
  if (!team.value) return null;
  return entries.value[team.value.team_num] || null;
});

function getStatuses(s) {
  const now = Date.now();
  const deadline = s.late_end_at || s.end_at;
  const deadlineTime = timestampMs(deadline);
  const endTime = timestampMs(s.end_at);
  const startTime = timestampMs(s.start_at);
  const isClosed = deadlineTime ? now > deadlineTime : false;
  const result = [];

  if (s.submission) {
    result.push(s.submission.is_late ? "late" : "submitted");
  } else if (isClosed) {
    result.push("closed");
    return result;
  } else if (s.late_end_at && endTime && now > endTime) {
    result.push("overdue");
    return result;
  } else if (startTime && now < startTime) {
    result.push("upcoming");
    return result;
  } else {
    result.push("pending");
    return result;
  }

  if (isClosed) result.push("closed");
  return result;
}

const statusLabels = { submitted: "제출 완료", late: "지각 제출", pending: "미제출", overdue: "지각", closed: "마감", upcoming: "예정" };
const statusClasses = { submitted: "badge-success", late: "badge-warning", pending: "badge-default", overdue: "badge-warning", closed: "badge-danger", upcoming: "badge-primary" };

function timestampMs(value) {
  return parseDbTimestamp(value)?.getTime() ?? 0;
}

onMounted(load);
</script>

<template>
  <div class="sessions-container">
    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <template v-else>
      <!-- 팀 정보 -->
      <div v-if="team && teamEntry" class="card">
        <div class="card-header">
          <h3>{{ team.team_num }} {{ teamEntry.univ }} {{ teamEntry.team }}</h3>
        </div>
      </div>
      <div v-else-if="!team" class="card">
        <div class="card-body"><p class="empty-text">팀이 배정되지 않았습니다. 관리자에게 문의하세요.</p></div>
      </div>

      <!-- 세션 목록 -->
      <div v-if="sessions.length === 0 && team" class="card">
        <div class="card-body"><p class="empty-text">현재 열린 제출 세션이 없습니다.</p></div>
      </div>

      <router-link v-for="s in sessions" :key="s.id" :to="'/session/' + s.id" class="card session-card">
        <div class="card-header session-header">
          <h3>{{ s.name }}</h3>
          <span v-for="st in getStatuses(s)" :key="st" class="badge" :class="statusClasses[st]">{{ statusLabels[st] }}</span>
        </div>
        <div class="card-body">
          <div class="info-list">
            <div class="info-row">
              <span class="info-label">제출 마감</span>
              <span class="info-value">{{ formatDate(s.end_at) }}</span>
            </div>
            <div v-if="s.late_end_at && s.late_end_at !== s.end_at" class="info-row">
              <span class="info-label">지각 마감</span>
              <span class="info-value">{{ formatDate(s.late_end_at) }}</span>
            </div>
            <div v-if="s.submission" class="info-row">
              <span class="info-label">내 제출일</span>
              <span class="info-value">{{ formatDate(s.submission.submitted_at) }}</span>
            </div>
          </div>
        </div>
      </router-link>
    </template>
  </div>
</template>

<style scoped>
.sessions-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}

.session-card {
  text-decoration: none;
  color: inherit;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  cursor: pointer;
}

.session-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-hover);
}

.session-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.session-header .badge:first-of-type {
  margin-left: auto;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.info-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  min-width: 4.5rem;
  flex-shrink: 0;
}

.info-value {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.empty-text {
  text-align: center;
  color: var(--text-tertiary);
  margin: 0;
}
</style>
