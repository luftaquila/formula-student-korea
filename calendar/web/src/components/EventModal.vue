<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";

const ROLE_OPTIONS = [
  { value: "public", label: "public" },
  { value: "student", label: "student" },
  { value: "official", label: "official" },
  { value: "chief", label: "chief" },
  { value: "admin", label: "admin" },
];

const props = defineProps({
  event: { type: Object, required: true },
});

const emit = defineEmits(["save", "delete", "close"]);

const title = ref(props.event.title || "");
const description = ref(props.event.description || "");
const location = ref(props.event.location || "");
const allDay = ref(props.event.allDay ?? true);
const role = ref(props.event.calendarId || props.event.role || "official");

const startDate = ref(parseDate(props.event.start));
const startTime = ref(parseTime(props.event.start));
const endDate = ref(parseDate(props.event.end));
const endTime = ref(parseTime(props.event.end));

const isEdit = computed(() => !!props.event.id);
const isValid = computed(() => title.value.trim() && startDate.value && endDate.value);

function parseDate(val) {
  if (!val) return "";
  if (/[zZ]$/.test(String(val))) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(d.getHours() + 9);
      return d.toISOString().slice(0, 10);
    }
  }
  return String(val).slice(0, 10);
}

function parseTime(val) {
  if (!val) return "09:00";
  if (/[zZ]$/.test(String(val))) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(d.getHours() + 9);
      return d.toISOString().slice(11, 16);
    }
  }
  const match = String(val).match(/(\d{2}:\d{2})/);
  return match ? match[1] : "09:00";
}

function buildDateTime(date, time) {
  if (allDay.value) return date;
  return `${date} ${time}`;
}

function handleSave() {
  if (!isValid.value) return;
  emit("save", {
    id: props.event.id || undefined,
    title: title.value.trim(),
    start: buildDateTime(startDate.value, startTime.value),
    end: buildDateTime(endDate.value, endTime.value),
    description: description.value.trim(),
    location: location.value.trim(),
    allDay: allDay.value,
    role: role.value,
  });
}

function handleDelete() {
  if (confirm("이 일정을 삭제하시겠습니까?")) {
    emit("delete", props.event.id);
  }
}

function handleKeydown(e) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", handleKeydown));
onUnmounted(() => document.removeEventListener("keydown", handleKeydown));
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" :aria-label="isEdit ? '일정 수정' : '일정 추가'">
      <div class="modal-header">
        <h2>{{ isEdit ? '일정 수정' : '일정 추가' }}</h2>
        <button class="modal-close" @click="emit('close')" aria-label="닫기">&times;</button>
      </div>

      <form class="modal-body" @submit.prevent="handleSave">
        <div class="field">
          <label for="event-title">제목 *</label>
          <input id="event-title" v-model="title" type="text" required autofocus placeholder="일정 제목" />
        </div>

        <div class="field-row">
          <label class="toggle-label">
            <input type="checkbox" v-model="allDay" />
            <span>종일</span>
          </label>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="event-start-date">시작</label>
            <input id="event-start-date" v-model="startDate" type="date" required />
            <input v-if="!allDay" v-model="startTime" type="time" required />
          </div>
          <div class="field">
            <label for="event-end-date">종료</label>
            <input id="event-end-date" v-model="endDate" type="date" required />
            <input v-if="!allDay" v-model="endTime" type="time" required />
          </div>
        </div>

        <div class="field">
          <label for="event-location">장소</label>
          <input id="event-location" v-model="location" type="text" placeholder="장소" />
        </div>

        <div class="field">
          <label for="event-description">설명</label>
          <textarea id="event-description" v-model="description" rows="3" placeholder="설명"></textarea>
        </div>

        <div class="field">
          <label for="event-role">공개 범위</label>
          <select id="event-role" v-model="role">
            <option v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>

        <div class="modal-actions">
          <button v-if="isEdit" type="button" class="btn btn-danger" @click="handleDelete">삭제</button>
          <div class="spacer"></div>
          <button type="button" class="btn btn-secondary" @click="emit('close')">취소</button>
          <button type="submit" class="btn btn-primary" :disabled="!isValid">{{ isEdit ? '수정' : '추가' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal {
  background: var(--bg-card, #fff);
  border-radius: 12px;
  width: 100%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}

.modal-header h2 {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary, #0f172a);
}

.modal-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: var(--text-secondary, #475569);
  padding: 0;
  line-height: 1;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.field label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary, #475569);
}

.field input,
.field textarea,
.field select {
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  font-size: 0.875rem;
  background: var(--bg-input, #fff);
  color: var(--text-primary, #0f172a);
  font-family: inherit;
  transition: border-color 0.2s;
}

.field input:focus,
.field textarea:focus,
.field select:focus {
  outline: none;
  border-color: var(--border-focus, #5e6ad2);
}

.field-row {
  display: flex;
  gap: 1rem;
}

.field-row > .field {
  flex: 1;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-primary, #0f172a);
  cursor: pointer;
}

.toggle-label input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent-primary, #5e6ad2);
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

.spacer { flex: 1; }

.btn {
  padding: 0.625rem 1.25rem;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary {
  background: var(--accent-primary, #5e6ad2);
  color: #fff;
  border-color: var(--accent-primary, #5e6ad2);
}

.btn-primary:hover:not(:disabled) { opacity: 0.9; }

.btn-secondary {
  background: var(--bg-secondary, #f8fafc);
  color: var(--text-primary, #0f172a);
}

.btn-secondary:hover { background: var(--bg-hover, #f1f5f9); }

.btn-danger {
  background: var(--accent-danger, #ef4444);
  color: #fff;
  border-color: var(--accent-danger, #ef4444);
}

.btn-danger:hover { opacity: 0.9; }

@media (max-width: 768px) {
  .modal-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .modal {
    max-width: 100%;
    max-height: 95vh;
    border-radius: 12px 12px 0 0;
  }

  .field-row {
    flex-direction: column;
    gap: 1rem;
  }
}
</style>
