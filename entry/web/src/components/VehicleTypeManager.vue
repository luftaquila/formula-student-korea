<script setup>
import { ref } from "vue";

defineProps({
  vehicleTypes: { type: Array, default: () => [] },
});

const emit = defineEmits(["add", "delete"]);

const newTypeName = ref("");

function handleAdd() {
  const name = newTypeName.value.trim();
  if (!name) return;
  emit("add", name);
  newTypeName.value = "";
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
        <button type="submit" class="btn btn-primary add-btn" :disabled="!newTypeName.trim()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </form>
      <ul v-if="vehicleTypes.length" class="type-list">
        <li v-for="vt in vehicleTypes" :key="vt.id" class="type-item">
          <span class="type-name">{{ vt.name }}</span>
          <button class="btn btn-danger btn-icon delete-btn" @click="handleDelete(vt.id)" title="삭제">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
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

.type-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
}

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
