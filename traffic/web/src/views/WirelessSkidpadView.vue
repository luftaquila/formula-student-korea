<script setup>
import { computed, onMounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useWirelessStore } from "../stores/wireless";
import { msToClockStr } from "../stores/serial";
import WirelessEventShell from "../components/WirelessEventShell.vue";

const entryStore = useEntryStore();
const store = useWirelessStore();
const slot = store.slot("skidpad");

onMounted(() => { if (!entryStore.isLoaded) entryStore.loadEntries(); });

const entries = computed(() => entryStore.entries);
const laps = computed(() => slot.run.lapTimes || []);
</script>

<template>
  <WirelessEventShell event-key="skidpad">
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
      <button class="btn btn-danger btn-block" @click="store.dnf('skidpad')">DNF</button>
    </template>
    <template #records>
      <div class="record-card card">
        <div class="card-header"><h3>⏱️ 랩 타임 (랩 2 + 랩 4 합산)</h3></div>
        <div class="card-body">
          <div v-if="laps.length" class="record-list">
            <div
              v-for="lap in laps"
              :key="lap.lap"
              class="record-item"
              :class="{ scored: lap.lap === 2 || lap.lap === 4 }"
            >랩 {{ lap.lap }} : {{ lap.display }}</div>
          </div>
          <div v-else class="empty-state">대기 중...</div>
        </div>
      </div>
      <div v-if="slot.run.savedRecord" class="saved-section card">
        <div class="card-header"><h3>🏁 합산 기록</h3></div>
        <div class="card-body">
          <div class="saved-item is-saved" data-testid="wl-result">
            {{ msToClockStr(slot.run.savedRecord.total) }} <span class="save-badge">💾</span>
          </div>
        </div>
      </div>
    </template>
  </WirelessEventShell>
</template>

<style scoped>
.record-list { display: flex; flex-direction: column; gap: 0.5rem; }
.record-item { padding: 0.5rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.125rem; font-weight: 600; text-align: center; }
.record-item.scored { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.25); }
.saved-item { padding: 0.75rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.5rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
.saved-item.is-saved { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-success); }
.save-badge { font-size: 1rem; }
</style>
