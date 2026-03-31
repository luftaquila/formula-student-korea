<script setup>
import { ref } from "vue";

defineProps({
  vehicleTypes: { type: Array, default: () => [] },
});

const emit = defineEmits(["add", "update", "delete"]);

const colors = ["blue", "green", "orange", "purple", "red", "teal"];
const colorLabels = { blue: "파랑", green: "초록", orange: "주황", purple: "보라", red: "빨강", teal: "청록" };

const newTypeName = ref("");
const newTypeColor = ref("blue");

function handleAdd() {
  const name = newTypeName.value.trim();
  if (!name) return;
  emit("add", { name, color: newTypeColor.value });
  newTypeName.value = "";
  newTypeColor.value = "blue";
}

function handleColorChange(id, color) {
  emit("update", { id, color });
}

function handleDelete(id) {
  if (confirm("이 차량 유형을 삭제하시겠습니까?\n해당 유형이 지정된 엔트리는 유형이 초기화됩니다.")) {
    emit("delete", id);
  }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
          <rect x="1" y="3" width="15" height="13" rx="2" />
          <path d="M16 8h2a2 2 0 012 2v8a2 2 0 01-2 2H8a2 2 0 01-2-2v-2" />
        </svg>
        차량 유형 관리
      </h3>
    </div>
    <div class="card-body">
      <form class="add-form" @submit.prevent="handleAdd">
        <input v-model="newTypeName" type="text" class="form-input" placeholder="유형 이름" />
        <div class="color-picker-inline">
          <button
            v-for="c in colors" :key="c"
            type="button"
            class="color-dot"
            :class="['color-' + c, { selected: newTypeColor === c }]"
            :title="colorLabels[c]"
            @click="newTypeColor = c"
          />
        </div>
        <button type="submit" class="btn btn-primary add-btn" :disabled="!newTypeName.trim()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </form>
      <ul v-if="vehicleTypes.length" class="type-list">
        <li v-for="vt in vehicleTypes" :key="vt.id" class="type-item">
          <span class="badge" :class="'badge-type-' + vt.color">{{ vt.name }}</span>
          <div class="type-actions">
            <div class="color-picker-inline">
              <button
                v-for="c in colors" :key="c"
                type="button"
                class="color-dot small"
                :class="['color-' + c, { selected: vt.color === c }]"
                :title="colorLabels[c]"
                @click="handleColorChange(vt.id, c)"
              />
            </div>
            <button class="btn btn-danger btn-icon delete-btn" @click="handleDelete(vt.id)" title="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-text">등록된 차량 유형이 없습니다</p>
    </div>
  </div>
</template>

<style scoped>
.header-icon {
  width: 18px;
  height: 18px;
}

.add-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.add-form .form-input {
  flex: 1;
}

.add-btn {
  padding: 0.5rem;
  flex-shrink: 0;
}

.add-btn svg {
  width: 18px;
  height: 18px;
}

.color-picker-inline {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.color-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 0;
}

.color-dot.small {
  width: 16px;
  height: 16px;
}

.color-dot.selected {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px var(--bg-card);
}

.color-dot.color-blue { background: #3b82f6; }
.color-dot.color-green { background: #16a34a; }
.color-dot.color-orange { background: #d97706; }
.color-dot.color-purple { background: #7c3aed; }
.color-dot.color-red { background: #dc2626; }
.color-dot.color-teal { background: #0d9488; }

.type-list {
  list-style: none;
  padding: 0;
  margin: 0.75rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.type-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.type-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
}

.badge-type-blue { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
.badge-type-green { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.badge-type-orange { background: rgba(245, 158, 11, 0.12); color: #d97706; }
.badge-type-purple { background: rgba(139, 92, 246, 0.12); color: #7c3aed; }
.badge-type-red { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.badge-type-teal { background: rgba(20, 184, 166, 0.12); color: #0d9488; }

.delete-btn {
  opacity: 0.5;
  transition: opacity 0.15s ease;
}

.delete-btn:hover {
  opacity: 1;
}

.delete-btn svg {
  width: 14px;
  height: 14px;
}

.empty-text {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  text-align: center;
}
</style>
