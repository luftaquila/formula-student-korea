<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  entries: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['update', 'delete'])

const editingRow = ref(null)
const editForm = ref({ num: '', univ: '', team: '' })

function startEdit(entry) {
  editingRow.value = entry.num
  editForm.value = { 
    num: entry.num, 
    univ: entry.univ, 
    team: entry.team,
    originalNum: entry.num
  }
}

function cancelEdit() {
  editingRow.value = null
  editForm.value = { num: '', univ: '', team: '' }
}

function saveEdit() {
  const numChanged = editForm.value.num !== editForm.value.originalNum
  emit('update', {
    num: editForm.value.num,
    univ: editForm.value.univ,
    team: editForm.value.team,
    num_changed: numChanged,
    prev: editForm.value.originalNum
  })
  cancelEdit()
}

function handleDelete(num) {
  if (confirm(`${num}번 엔트리를 삭제하시겠습니까?`)) {
    emit('delete', num)
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter') {
    saveEdit()
  } else if (e.key === 'Escape') {
    cancelEdit()
  }
}
</script>

<template>
  <div class="table-wrapper">
    <table class="entry-table">
      <thead>
        <tr>
          <th class="col-num">번호</th>
          <th class="col-univ">학교</th>
          <th class="col-team">팀명</th>
          <th class="col-actions">관리</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="entries.length === 0">
          <td colspan="4" class="empty-state">
            <div class="empty-content">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
              </svg>
              <p>등록된 엔트리가 없습니다</p>
            </div>
          </td>
        </tr>
        <tr 
          v-for="entry in entries" 
          :key="entry.num"
          :class="{ 'editing': editingRow === entry.num }"
        >
          <template v-if="editingRow === entry.num">
            <td class="col-num">
              <input 
                v-model.number="editForm.num" 
                type="number" 
                class="edit-input"
                @keydown="handleKeydown"
              />
            </td>
            <td class="col-univ">
              <input 
                v-model="editForm.univ" 
                type="text" 
                class="edit-input"
                @keydown="handleKeydown"
              />
            </td>
            <td class="col-team">
              <input 
                v-model="editForm.team" 
                type="text" 
                class="edit-input"
                @keydown="handleKeydown"
              />
            </td>
            <td class="col-actions">
              <div class="action-buttons">
                <button class="btn btn-success btn-icon" @click="saveEdit" title="저장">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </button>
                <button class="btn btn-ghost btn-icon" @click="cancelEdit" title="취소">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </td>
          </template>
          <template v-else>
            <td class="col-num">
              <span class="entry-number">{{ entry.num }}</span>
            </td>
            <td class="col-univ">{{ entry.univ }}</td>
            <td class="col-team">{{ entry.team }}</td>
            <td class="col-actions">
              <div class="action-buttons">
                <button class="btn btn-ghost btn-icon" @click="startEdit(entry)" title="수정">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="btn btn-danger btn-icon" @click="handleDelete(entry.num)" title="삭제">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                  </svg>
                </button>
              </div>
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrapper {
  overflow-x: auto;
}

.entry-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.entry-table th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.entry-table td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
}

.entry-table tbody tr {
  transition: background-color 0.15s ease;
}

.entry-table tbody tr:hover {
  background: var(--bg-hover);
}

.entry-table tbody tr.editing {
  background: rgba(59, 130, 246, 0.1);
}

.col-num {
  width: 80px;
}

.col-univ {
  width: 160px;
}

.col-team {
  min-width: 200px;
}

.col-actions {
  width: 100px;
  text-align: center;
}

.entry-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 0.25rem 0.5rem;
  background: var(--bg-primary);
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--accent-primary);
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  justify-content: center;
}

.action-buttons .btn-icon {
  opacity: 0.7;
  transition: opacity 0.15s ease;
}

.entry-table tbody tr:hover .action-buttons .btn-icon {
  opacity: 1;
}

.action-buttons .btn-icon svg {
  width: 16px;
  height: 16px;
}

.edit-input {
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: var(--bg-input);
  border: 1px solid var(--border-focus);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.edit-input:focus {
  outline: none;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.empty-state {
  padding: 3rem !important;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-tertiary);
}

.empty-icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}

.empty-content p {
  font-size: 0.9375rem;
}
</style>

