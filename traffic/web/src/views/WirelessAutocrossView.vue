<script setup>
import { computed, onMounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useWirelessStore } from "../stores/wireless";
import WirelessEventShell from "../components/WirelessEventShell.vue";

const entryStore = useEntryStore();
const store = useWirelessStore();
const slot = store.slot("autocross");

onMounted(() => { if (!entryStore.isLoaded) entryStore.loadEntries(); });

const entries = computed(() => entryStore.entries);
const passes = computed(() => slot.run.displayRecords || []);
</script>

<template>
  <WirelessEventShell event-key="autocross">
    <template #teams="{ locked }">
      <div class="form-group">
        <label class="form-label">참가팀</label>
        <select v-model="slot.config.team" class="form-input" :disabled="locked" data-testid="wl-team">
          <option :value="null" disabled>팀 선택</option>
          <option v-for="e in entries" :key="e.num" :value="e.num">{{ e.num }} {{ e.univ }} {{ e.team }}</option>
        </select>
      </div>
    </template>
    <template #actions>
      <button class="btn btn-danger btn-block" @click="store.dnf('autocross')">DNF</button>
    </template>
    <template #records>
      <div class="record-card card">
        <div class="card-header"><h3>🚧 통과 기록 (2번째 통과부터 저장)</h3></div>
        <div class="card-body">
          <div v-if="passes.length" class="record-list">
            <div v-for="(r, i) in passes" :key="i" class="record-item">{{ i + 1 }}회 : {{ r.time }}</div>
          </div>
          <div v-else class="empty-state">대기 중...</div>
        </div>
      </div>
      <div v-if="slot.run.savedRecord" class="saved-section card">
        <div class="card-header"><h3>🏁 측정 기록</h3></div>
        <div class="card-body">
          <div class="saved-item is-saved" data-testid="wl-result">
            {{ slot.run.savedRecord.time }} <span class="save-badge">💾</span>
          </div>
        </div>
      </div>
    </template>
  </WirelessEventShell>
</template>

<style scoped>
.record-list { display: flex; flex-direction: column; gap: 0.5rem; }
.record-item { padding: 0.5rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.125rem; font-weight: 600; text-align: center; }
.saved-item { padding: 0.75rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.5rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
.saved-item.is-saved { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-success); }
.save-badge { font-size: 1rem; }
</style>
