<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useNotification } from "@shared/useNotification.js";
import { request, fetchEntryYears, fetchEntries, fetchVehicleTypes } from "../api.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";

const route = useRoute();
const router = useRouter();
const { notyf } = useNotification();

const isEdit = computed(() => !!route.params.id && route.path.endsWith("/edit"));
const loading = ref(true);
const saving = ref(false);

const years = ref([]);
const selectedYear = ref(null);
const entries = ref([]);

const form = ref({
  name: "",
  notice: "",
  start: "",
  end: "",
  late_end: "",
  max_file_size_mb: 50,
  allowed_extensions: "",
  teams: [],
});

// 수정 모드에서 제출물 보유 팀 추적 (제거 시 확인 다이얼로그용)
const originalTeamsWithSubmissions = ref(new Set());

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

watch(selectedYear, () => { loadEntries(); loadTypeColors(); });

const entryList = computed(() =>
  Object.entries(entries.value)
    .map(([num, e]) => ({ num: Number(num), ...e }))
    .sort((a, b) => a.num - b.num),
);

const filteredEntryList = computed(() =>
  entryList.value.filter((e) => !e.type || typeFilters.value[e.type] !== false),
);

const vehicleTypes = computed(() => Object.keys(typeFilters.value).sort());

// 유형 색상 (엔트리 서비스에서 가져옴)
const typeColorMap = ref({});
function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
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
  const d = parseDbTimestamp(utc);
  if (!d) return "";
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function localToUTC(datetimeLocal) {
  if (!datetimeLocal) return "";
  const d = new Date(datetimeLocal);
  return d.toISOString();
}

async function loadSession() {
  if (!isEdit.value) { loading.value = false; return; }
  try {
    const res = await request(`/api/admin/sessions/${route.params.id}/status`);
    const data = await res.json();
    const s = data.session;
    selectedYear.value = s.year;
    form.value = {
      name: s.name,
      notice: s.notice || "",
      start: utcToLocal(s.start_at),
      end: utcToLocal(s.end_at),
      late_end: utcToLocal(s.late_end_at),
      max_file_size_mb: Math.round(s.max_file_size / 1024 / 1024),
      allowed_extensions: s.allowed_extensions || "",
      teams: data.status.map((t) => t.team_num),
    };
    originalTeamsWithSubmissions.value = new Set(
      data.status.filter((t) => t.submission).map((t) => t.team_num),
    );
  } catch {
    router.push("/admin");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.value.name.trim()) { notyf.error("세션 이름을 입력하세요."); return; }
  if (!form.value.start || !form.value.end) { notyf.error("시간을 모두 입력하세요."); return; }
  if (form.value.teams.length === 0) { notyf.error("대상 팀을 선택하세요."); return; }

  const startUTC = localToUTC(form.value.start);
  const endUTC = localToUTC(form.value.end);
  const lateEndUTC = form.value.late_end ? localToUTC(form.value.late_end) : "";

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
      // 제출물이 있는 팀이 제거되는 경우 확인
      const removedWithSubs = [...originalTeamsWithSubmissions.value].filter(
        (n) => !form.value.teams.includes(n),
      );
      if (removedWithSubs.length > 0) {
        if (!confirm(`팀 ${removedWithSubs.join(", ")}번의 제출물과 파일이 영구 삭제됩니다. 계속하시겠습니까?`)) {
          saving.value = false;
          return;
        }
      }

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

async function loadTypeColors() {
  if (!selectedYear.value) return;
  try {
    const vtList = await fetchVehicleTypes(selectedYear.value);
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
  } catch { /* 색상 로드 실패 시 기본값 사용 */ }
}

onMounted(async () => {
  await loadYears();
  await Promise.all([loadEntries(), loadTypeColors()]);
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
              <label>세션 이름</label>
              <input v-model="form.name" type="text" class="form-input" required />
            </div>

            <div class="form-group">
              <label>공지 메시지</label>
              <textarea v-model="form.notice" class="form-input form-textarea" rows="3" placeholder="선택사항"></textarea>
            </div>

            <div class="time-section">
              <div class="time-row">
                <label class="time-label">시작</label>
                <input v-model="form.start" type="datetime-local" class="form-input" required />
              </div>
              <div class="time-row">
                <label class="time-label">마감</label>
                <input v-model="form.end" type="datetime-local" class="form-input" required />
              </div>
              <div class="time-row">
                <label class="time-label">지각 마감 (선택)</label>
                <input v-model="form.late_end" type="datetime-local" class="form-input" />
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
  min-width: 8rem;
  flex-shrink: 0;
}

.time-row .form-input {
  width: auto;
  flex: 1;
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
  background: rgba(94, 106, 210, 0.08);
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

  .constraint-row {
    grid-template-columns: 1fr;
  }
}
</style>
