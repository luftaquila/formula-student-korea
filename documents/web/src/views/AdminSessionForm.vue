<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Notyf } from "notyf";
import { request, fetchEntryYears, fetchEntries } from "../api.js";

const route = useRoute();
const router = useRouter();
const notyf = new Notyf({ duration: 3000, position: { x: "right", y: "top" } });

const isEdit = computed(() => !!route.params.id && route.path.endsWith("/edit"));
const loading = ref(true);
const saving = ref(false);

const years = ref([]);
const selectedYear = ref(null);
const entries = ref([]);

const form = ref({
  name: "",
  notice: "",
  start_date: "",
  start_h: "00",
  start_m: "00",
  end_date: "",
  end_h: "23",
  end_m: "59",
  late_end_date: "",
  late_end_h: "23",
  late_end_m: "59",
  max_file_size_mb: 50,
  allowed_extensions: "",
  teams: [],
});

const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

// 차량 유형 필터
const typeFilters = ref({});

async function loadYears() {
  try {
    years.value = await fetchEntryYears();
    if (years.value.length > 0) selectedYear.value = years.value[0];
  } catch (e) {
    notyf.error(e.message);
  }
}

async function loadEntries() {
  if (!selectedYear.value) return;
  try {
    entries.value = await fetchEntries(selectedYear.value);
    // 유형 필터 초기화 (전체 활성)
    const types = [...new Set(Object.values(entries.value).map((e) => e.type).filter(Boolean))];
    typeFilters.value = Object.fromEntries(types.map((t) => [t, true]));
  } catch (e) {
    notyf.error(e.message);
  }
}

watch(selectedYear, loadEntries);

const entryList = computed(() =>
  Object.entries(entries.value)
    .map(([num, e]) => ({ num: Number(num), ...e }))
    .sort((a, b) => a.num - b.num),
);

const filteredEntryList = computed(() =>
  entryList.value.filter((e) => !e.type || typeFilters.value[e.type] !== false),
);

const teamNums = computed(() => entryList.value.map((e) => e.num));
const vehicleTypes = computed(() => Object.keys(typeFilters.value).sort());

// 성적표와 동일한 유형 색상
const typeColors = ["blue", "green", "orange", "purple", "red", "teal"];
const typeColorMap = {};
function getTypeColor(type) {
  if (!type) return "blue";
  if (!typeColorMap[type]) {
    const idx = Object.keys(typeColorMap).length % typeColors.length;
    typeColorMap[type] = typeColors[idx];
  }
  return typeColorMap[type];
}

function toggleTeam(num) {
  const idx = form.value.teams.indexOf(num);
  if (idx >= 0) form.value.teams.splice(idx, 1);
  else form.value.teams.push(num);
}

function toggleAll() {
  const visibleNums = filteredEntryList.value.map((e) => e.num);
  const allSelected = visibleNums.every((n) => form.value.teams.includes(n));
  if (allSelected) {
    form.value.teams = form.value.teams.filter((n) => !visibleNums.includes(n));
  } else {
    const current = new Set(form.value.teams);
    for (const n of visibleNums) current.add(n);
    form.value.teams = [...current];
  }
}

const allFilteredSelected = computed(() => {
  const visibleNums = filteredEntryList.value.map((e) => e.num);
  return visibleNums.length > 0 && visibleNums.every((n) => form.value.teams.includes(n));
});

function utcToLocal(utc) {
  if (!utc) return { date: "", h: "00", m: "00" };
  const d = new Date(utc + "Z");
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return {
    date: local.toISOString().slice(0, 10),
    h: String(local.getUTCHours()).padStart(2, "0"),
    m: String(local.getUTCMinutes()).padStart(2, "0"),
  };
}

function localToUTC(date, h, m) {
  if (!date) return "";
  const d = new Date(`${date}T${h || "00"}:${m || "00"}`);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

async function loadSession() {
  if (!isEdit.value) { loading.value = false; return; }
  try {
    const res = await request(`/api/admin/sessions/${route.params.id}/status`);
    const data = await res.json();
    const s = data.session;
    selectedYear.value = s.year;
    const start = utcToLocal(s.start_at);
    const end = utcToLocal(s.end_at);
    const lateEnd = utcToLocal(s.late_end_at);
    form.value = {
      name: s.name,
      notice: s.notice || "",
      start_date: start.date, start_h: start.h, start_m: start.m,
      end_date: end.date, end_h: end.h, end_m: end.m,
      late_end_date: lateEnd.date, late_end_h: lateEnd.h, late_end_m: lateEnd.m,
      max_file_size_mb: Math.round(s.max_file_size / 1024 / 1024),
      allowed_extensions: s.allowed_extensions || "",
      teams: data.status.map((t) => t.team_num),
    };
  } catch {
    router.push("/admin");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.value.name.trim()) { notyf.error("세션명을 입력하세요."); return; }
  if (!form.value.start_date || !form.value.end_date) { notyf.error("날짜를 모두 입력하세요."); return; }
  if (form.value.teams.length === 0) { notyf.error("대상 팀을 선택하세요."); return; }

  const startUTC = localToUTC(form.value.start_date, form.value.start_h, form.value.start_m);
  const endUTC = localToUTC(form.value.end_date, form.value.end_h, form.value.end_m);
  const lateEndUTC = form.value.late_end_date
    ? localToUTC(form.value.late_end_date, form.value.late_end_h, form.value.late_end_m)
    : "";

  if (endUTC <= startUTC) { notyf.error("제출 마감은 시작 이후여야 합니다."); return; }
  if (lateEndUTC && lateEndUTC < endUTC) { notyf.error("지각 마감은 제출 마감 이후여야 합니다."); return; }

  saving.value = true;
  try {
    const body = {
      name: form.value.name.trim(),
      notice: form.value.notice,
      start_at: startUTC,
      end_at: endUTC,
      late_end_at: lateEndUTC,
      max_file_size: form.value.max_file_size_mb * 1024 * 1024,
      allowed_extensions: form.value.allowed_extensions
        .split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean).join(","),
      year: selectedYear.value,
      teams: form.value.teams,
    };

    if (isEdit.value) {
      await request(`/api/admin/sessions/${route.params.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      notyf.success("세션을 수정했습니다.");
      router.push(`/admin/session/${route.params.id}`);
    } else {
      const res = await request("/api/admin/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const { id } = await res.json();
      notyf.success("세션을 생성했습니다.");
      router.push(`/admin/session/${id}`);
    }
  } catch (e) {
    notyf.error(e.message);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await loadYears();
  await loadEntries();
  await loadSession();
});
</script>

<template>
  <div class="form-container">
    <button class="btn btn-ghost back-btn" @click="router.push('/admin')">← 목록으로</button>

    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <template v-else>
      <div class="card">
        <div class="card-header">
          <h3>{{ isEdit ? "세션 수정" : "세션 생성" }}</h3>
        </div>
        <div class="card-body">
          <form @submit.prevent="save" class="session-form">
            <div class="form-group">
              <label>연도</label>
              <select v-model="selectedYear" class="form-select" :disabled="isEdit">
                <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
              </select>
            </div>

            <div class="form-group">
              <label>세션명</label>
              <input v-model="form.name" type="text" class="form-input" required />
            </div>

            <div class="form-group">
              <label>공지 메시지</label>
              <textarea v-model="form.notice" class="form-input form-textarea" rows="3" placeholder="선택사항"></textarea>
            </div>

            <div class="time-section">
              <div class="time-row">
                <label class="time-label">시작</label>
                <input v-model="form.start_date" type="date" class="form-input" required />
                <div class="time-selects">
                  <select v-model="form.start_h" class="form-select time-sel"><option v-for="h in hours" :key="h" :value="h">{{ h }}</option></select>
                  <span class="time-unit">시</span>
                  <select v-model="form.start_m" class="form-select time-sel"><option v-for="m in minutes" :key="m" :value="m">{{ m }}</option></select>
                  <span class="time-unit">분</span>
                </div>
              </div>
              <div class="time-row">
                <label class="time-label">마감</label>
                <input v-model="form.end_date" type="date" class="form-input" required />
                <div class="time-selects">
                  <select v-model="form.end_h" class="form-select time-sel"><option v-for="h in hours" :key="h" :value="h">{{ h }}</option></select>
                  <span class="time-unit">시</span>
                  <select v-model="form.end_m" class="form-select time-sel"><option v-for="m in minutes" :key="m" :value="m">{{ m }}</option></select>
                  <span class="time-unit">분</span>
                </div>
              </div>
              <div class="time-row">
                <label class="time-label">지각 마감</label>
                <input v-model="form.late_end_date" type="date" class="form-input" />
                <div class="time-selects">
                  <select v-model="form.late_end_h" class="form-select time-sel"><option v-for="h in hours" :key="h" :value="h">{{ h }}</option></select>
                  <span class="time-unit">시</span>
                  <select v-model="form.late_end_m" class="form-select time-sel"><option v-for="m in minutes" :key="m" :value="m">{{ m }}</option></select>
                  <span class="time-unit">분</span>
                </div>
              </div>
            </div>

            <div class="constraint-row">
              <div class="form-group">
                <label>파일 용량 제한 (MB)</label>
                <input v-model.number="form.max_file_size_mb" type="number" min="1" max="500" class="form-input" />
              </div>
              <div class="form-group">
                <label>허용 확장자</label>
                <input v-model="form.allowed_extensions" type="text" class="form-input" placeholder="예: pdf, docx, xlsx (비우면 전체 허용)" />
              </div>
            </div>

            <div class="form-group">
              <div class="team-header">
                <label>대상 팀 ({{ form.teams.length }})</label>
                <span class="type-filter-group">
                  <label v-for="t in vehicleTypes" :key="t" class="type-filter">
                    <input type="checkbox" v-model="typeFilters[t]" />
                    <span class="badge" :class="'badge-type-' + getTypeColor(t)">{{ t }}</span>
                  </label>
                </span>
                <button type="button" class="btn btn-sm btn-ghost" @click="toggleAll">
                  {{ allFilteredSelected ? "전체 해제" : "전체 선택" }}
                </button>
              </div>
              <div class="team-grid">
                <label v-for="e in filteredEntryList" :key="e.num" class="team-checkbox" :class="{ checked: form.teams.includes(e.num) }">
                  <input type="checkbox" :checked="form.teams.includes(e.num)" @change="toggleTeam(e.num)" />
                  <span class="team-num">{{ e.num }}</span>
                  <span class="team-info">{{ e.univ }} {{ e.team }}</span>
                  <span class="badge" :class="'badge-type-' + getTypeColor(e.type)">{{ e.type }}</span>
                </label>
              </div>
            </div>

            <button type="submit" class="btn btn-primary" :disabled="saving">
              {{ saving ? "저장 중..." : isEdit ? "수정" : "생성" }}
            </button>
          </form>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.form-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}

.back-btn {
  align-self: flex-start;
}

.session-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 0;
}

.form-group label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.form-textarea {
  resize: vertical;
  min-height: 3rem;
}

.time-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.time-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.time-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 5rem;
  flex-shrink: 0;
}

.time-row .form-input {
  width: auto;
}

.time-selects {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.time-sel {
  padding: 0.5rem 0.375rem;
  min-width: 3.5rem;
  text-align: center;
  font-family: "JetBrains Mono", monospace;
}

.time-unit {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.constraint-row {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 0.75rem;
}

.team-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.team-header label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
}

/* 차량 유형 필터 */
.type-filter-group {
  display: inline-flex;
  gap: 0.375rem;
  align-items: center;
}

.type-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  cursor: pointer;
  font-weight: 400;
}

.type-filter input {
  cursor: pointer;
  width: 0.875rem;
  height: 0.875rem;
}

/* 팀 목록 */
.team-grid {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.team-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.8125rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.team-checkbox:hover {
  background: var(--bg-hover);
}

.team-checkbox.checked {
  background: rgba(59, 130, 246, 0.08);
  border-color: var(--accent-primary);
}

.team-checkbox input {
  cursor: pointer;
  flex-shrink: 0;
}

.team-num {
  font-weight: 700;
  min-width: 1.5rem;
  flex-shrink: 0;
}

.team-info {
  flex: 1;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 성적표 동일 유형 뱃지 색상 */
.badge-type-blue { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
.badge-type-green { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.badge-type-orange { background: rgba(245, 158, 11, 0.12); color: #d97706; }
.badge-type-purple { background: rgba(139, 92, 246, 0.12); color: #7c3aed; }
.badge-type-red { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.badge-type-teal { background: rgba(20, 184, 166, 0.12); color: #0d9488; }

.loading {
  display: flex;
  justify-content: center;
  padding: 3rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .time-row {
    flex-direction: column;
    align-items: stretch;
  }

  .time-label {
    min-width: 0;
  }

  .time-row .form-input {
    width: 100%;
  }

  .time-selects {
    width: 100%;
  }

  .time-sel {
    flex: 1;
  }

  .constraint-row {
    grid-template-columns: 1fr;
  }
}
</style>
