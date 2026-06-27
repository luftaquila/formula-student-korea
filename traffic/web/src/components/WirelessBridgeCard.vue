<script setup>
import { computed } from "vue";
import { useWirelessStore } from "../stores/wireless";
import { useSSE } from "../composables/useSSE";

const store = useWirelessStore();
const { connected } = useSSE();

const masterOk = computed(() => store.bridgeIsSelf || store.bridge.online);
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>📡 연결</h3></div>
    <div class="card-body">
      <div class="wl-conn">
        <div class="wl-line">
          <span class="wl-label">서버</span>
          <span class="wl-dot" :class="connected ? 'ok' : 'bad'"></span>
        </div>
        <div class="wl-line">
          <span class="wl-label">마스터</span>
          <span class="wl-dot" :class="masterOk ? 'ok' : 'bad'" data-testid="bridge-status"></span>
          <span v-if="store.masterId" class="wl-id mono" data-testid="bridge-master-id">{{ store.masterId }}</span>
        </div>
        <button
          v-if="!store.bridgeIsSelf"
          class="btn btn-success wl-conn-btn"
          :disabled="store.bridge.online"
          data-testid="bridge-connect"
          @click="store.openSerial()"
        >마스터 연결</button>
        <button v-else class="btn btn-ghost wl-conn-btn" @click="store.closeSerial()">연결 해제</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.wl-conn { display: flex; align-items: center; gap: 1.5rem; }
.wl-conn-btn { margin-left: auto; padding: 0.4rem 0.9rem; font-size: 0.85rem; }
.wl-line { display: flex; align-items: center; gap: 0.5rem; }
.wl-label { color: var(--text-secondary); font-size: 0.9rem; }
.wl-id { color: var(--text-tertiary); font-size: 0.8rem; letter-spacing: 0.02em; }
.mono { font-family: "JetBrains Mono", monospace; }
.wl-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.wl-dot.ok { background: var(--accent-success); box-shadow: 0 0 6px var(--accent-success); }
.wl-dot.bad { background: var(--accent-danger); }
</style>
