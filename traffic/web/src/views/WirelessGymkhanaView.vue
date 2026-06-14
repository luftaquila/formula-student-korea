<script setup>
import { computed, onMounted, watch } from "vue";
import { useEntryStore } from "../stores/entry";
import { useWirelessStore } from "../stores/wireless";
import { useNotification } from "@shared/useNotification.js";
import WirelessEventShell from "../components/WirelessEventShell.vue";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const store = useWirelessStore();
const slot = store.slot("gymkhana");

onMounted(() => { if (!entryStore.isLoaded) entryStore.loadEntries(); });

const entries = computed(() => entryStore.entries);
const lane1 = computed(() => slot.run.displayRecords?.[1] || []);
const lane2 = computed(() => slot.run.displayRecords?.[2] || []);

watch(() => slot.config.teamLane1, (v) => {
  if (v && v === slot.config.teamLane2) { slot.config.teamLane1 = null; notyf.error("이미 다른 레인에 선택된 팀입니다."); }
});
watch(() => slot.config.teamLane2, (v) => {
  if (v && v === slot.config.teamLane1) { slot.config.teamLane2 = null; notyf.error("이미 다른 레인에 선택된 팀입니다."); }
});
</script>

<template>
  <WirelessEventShell event-key="gymkhana">
    <template #teams="{ locked }">
      <div class="form-group">
        <label class="form-label">레인 1 팀</label>
        <select v-model="slot.config.teamLane1" class="form-input" :disabled="locked" data-testid="wl-team-lane1">
          <option :value="null" disabled>팀 선택</option>
          <option v-for="e in entries" :key="e.num" :value="e.num">{{ e.num }} {{ e.univ }} {{ e.team }}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">레인 2 팀</label>
        <select v-model="slot.config.teamLane2" class="form-input" :disabled="locked" data-testid="wl-team-lane2">
          <option :value="null" disabled>팀 선택</option>
          <option v-for="e in entries" :key="e.num" :value="e.num">{{ e.num }} {{ e.univ }} {{ e.team }}</option>
        </select>
      </div>
    </template>
    <template #actions>
      <div class="btn-group">
        <button class="btn btn-danger" @click="store.dnf('gymkhana', 1)">레인1 DNF</button>
        <button class="btn btn-danger" @click="store.dnf('gymkhana', 2)">레인2 DNF</button>
      </div>
    </template>
    <template #records>
      <div class="records-section">
        <div class="record-card card">
          <div class="card-header"><h3>🏁 레인 1</h3></div>
          <div class="card-body">
            <div v-if="lane1.length" class="record-list">
              <div v-for="(r, i) in lane1" :key="i" class="record-item">{{ i + 1 }}회 : {{ r.time }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
            <div v-if="slot.run.savedRecords[1]" class="saved-item is-saved mt-1">{{ slot.run.savedRecords[1].time }} 💾</div>
          </div>
        </div>
        <div class="record-card card">
          <div class="card-header"><h3>🏁 레인 2</h3></div>
          <div class="card-body">
            <div v-if="lane2.length" class="record-list">
              <div v-for="(r, i) in lane2" :key="i" class="record-item">{{ i + 1 }}회 : {{ r.time }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
            <div v-if="slot.run.savedRecords[2]" class="saved-item is-saved mt-1">{{ slot.run.savedRecords[2].time }} 💾</div>
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
.saved-item { padding: 0.6rem 1rem; background: var(--bg-secondary); border-radius: 8px; font-family: "JetBrains Mono", monospace; font-size: 1.25rem; font-weight: 700; text-align: center; }
.saved-item.is-saved { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-success); }
@media (max-width: 1024px) { .records-section { grid-template-columns: 1fr; } }
</style>
