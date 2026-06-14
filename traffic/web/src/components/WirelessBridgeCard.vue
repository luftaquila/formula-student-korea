<script setup>
import { useWirelessStore } from "../stores/wireless";
import { useSSE } from "../composables/useSSE";

const store = useWirelessStore();
const { connected } = useSSE();
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>📡 마스터 브리지</h3></div>
    <div class="card-body">
      <div class="wl-status">
        <span class="wl-dot" :class="connected ? 'ok' : 'bad'"></span>
        <span>{{ connected ? "서버 연결됨" : "서버 연결 끊김" }}</span>
      </div>
      <div class="wl-status">
        <span class="wl-dot" :class="store.bridge.online ? 'ok' : 'bad'" data-testid="bridge-status"></span>
        <span v-if="store.bridgeIsSelf">이 PC가 브리지입니다</span>
        <span v-else-if="store.bridge.online">브리지 온라인 (다른 PC)</span>
        <span v-else>브리지 오프라인</span>
      </div>

      <button
        v-if="!store.bridgeIsSelf"
        class="btn btn-success btn-block mt-1"
        :disabled="store.bridge.online"
        data-testid="bridge-connect"
        @click="store.openSerial()"
      >마스터 연결 (이 PC를 브리지로)</button>
      <button v-else class="btn btn-danger btn-block mt-1" @click="store.closeSerial()">브리지 연결 해제</button>

      <p class="wl-hint">USB로 마스터에 연결된 PC만 브리지가 됩니다. 다른 클라이언트는 인터넷(서버)으로 데이터를 받습니다.</p>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.wl-status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; margin-bottom: 0.4rem; }
.wl-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.wl-dot.ok { background: var(--accent-success); box-shadow: 0 0 6px var(--accent-success); }
.wl-dot.bad { background: var(--accent-danger); }
.wl-hint { font-size: 0.78rem; color: var(--text-tertiary); margin-top: 0.5rem; }
</style>
