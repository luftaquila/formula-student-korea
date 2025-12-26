<script setup>
import { ref } from 'vue'

const emit = defineEmits(['submit'])

const form = ref({
  num: '',
  univ: '',
  team: ''
})

const isSubmitting = ref(false)

async function handleSubmit() {
  if (!form.value.num || !form.value.univ.trim() || !form.value.team.trim()) {
    return
  }
  
  isSubmitting.value = true
  
  try {
    emit('submit', {
      num: Number(form.value.num),
      univ: form.value.univ.trim(),
      team: form.value.team.trim()
    })
    
    form.value = { num: '', univ: '', team: '' }
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
          <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="8.5" cy="7" r="4"/>
          <line x1="20" y1="8" x2="20" y2="14"/>
          <line x1="23" y1="11" x2="17" y2="11"/>
        </svg>
        새 엔트리 추가
      </h3>
    </div>
    <div class="card-body">
      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label">엔트리 번호</label>
          <input 
            v-model.number="form.num"
            type="number" 
            class="form-input"
            placeholder="1"
            min="0"
            required
          />
        </div>
        <div class="form-group">
          <label class="form-label">학교명</label>
          <input 
            v-model="form.univ"
            type="text" 
            class="form-input"
            placeholder="서울대학교"
            required
          />
        </div>
        <div class="form-group">
          <label class="form-label">팀명</label>
          <input 
            v-model="form.team"
            type="text" 
            class="form-input"
            placeholder="Racing Team"
            required
          />
        </div>
        <button 
          type="submit" 
          class="btn btn-primary submit-btn"
          :disabled="isSubmitting || !form.num || !form.univ.trim() || !form.team.trim()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          엔트리 추가
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.header-icon {
  width: 18px;
  height: 18px;
}

.submit-btn {
  width: 100%;
  margin-top: 0.5rem;
}

.submit-btn svg {
  width: 18px;
  height: 18px;
}
</style>

