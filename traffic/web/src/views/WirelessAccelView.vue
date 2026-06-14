<script setup>
import { computed, onMounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useWirelessStore } from "../stores/wireless";
import { msToClockStr } from "../stores/serial";
import WirelessEventShell from "../components/WirelessEventShell.vue";

const entryStore = useEntryStore();
const store = useWirelessStore();
const slot = store.slot("accel");

onMounted(() => { if (!entryStore.isLoaded) entryStore.loadEntries(); });

const entries = computed(() => entryStore.entries);
const startRecords = computed(() => slot.records.filter((r) => r.sensor === 1));
const endRecords = computed(() => slot.records.filter((r) => r.sensor === 2));
</script>

<template>
  <WirelessEventShell event-key="accel">
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
      <button class="btn btn-danger btn-block" @click="store.dnf('accel')">DNF</button>
    </template>
    <template #records>
      <div class="records-section">
        <div class="record-card card">
          <div class="card-header"><h3>🚀 출발점 (센서 1)</h3></div>
          <div class="card-body">
            <div v-if="startRecords.length" class="record-list">
              <div v-for="(r, i) in startRecords" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
          </div>
        </div>
        <div class="record-card card">
          <div class="card-header"><h3>🏁 도착점 (센서 2)</h3></div>
          <div class="card-body">
            <div v-if="endRecords.length" class="record-list">
              <div v-for="(r, i) in endRecords" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
          </div>
        </div>
      </div>
      <div v-if="slot.run.displayRecord" class="saved-section card">
        <div class="card-header"><h3>🏁 측정 기록</h3></div>
        <div class="card-body">
          <div class="saved-item" :class="{ 'is-saved': slot.run.savedRecord }" data-testid="wl-result">
            {{ slot.run.displayRecord.time }}
            <span v-if="slot.run.savedRecord" class="save-badge">💾</span>
          </div>
        </div>
      </div>
    </template>
  </WirelessEventShell>
</template>

<style scoped>
.records-section { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
.record-list { display: flex; flex-direction: column; gap: 0.5rem; }
.record-item { padding: 0.5rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.125rem; font-weight: 600; text-align: center; }
.saved-item { padding: 0.75rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.5rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
.saved-item.is-saved { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-success); }
.save-badge { font-size: 1rem; }
@media (max-width: 1024px) { .records-section { grid-template-columns: 1fr; } }
</style>
