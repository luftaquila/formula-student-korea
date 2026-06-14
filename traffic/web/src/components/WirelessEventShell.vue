<script setup>
import { computed } from "vue";
import { useWirelessStore } from "../stores/wireless";
import { useSSE } from "../composables/useSSE";
import { EVENT_TITLE } from "../composables/useEventTiming";

const props = defineProps({
  eventKey: { type: String, required: true },
});

const store = useWirelessStore();
const { connected } = useSSE();

const slot = store.slot(props.eventKey);
const isLocked = computed(() => slot.green.active);
const currentYear = new Date().getFullYear();
const titleText = computed(
  () => `${currentYear} FSK ${slot.config.eventName.trim() || EVENT_TITLE[props.eventKey]}`,
);
const lightColor = computed(() => store.lightColorFor(props.eventKey));
const isOwner = computed(() => store.ownerKey === props.eventKey);
const claimedByOther = computed(() => store.isClaimedByOther(props.eventKey));
const canGreen = computed(
  () => store.bridgeIsSelf && !claimedByOther.value && !slot.green.active,
);
const canControl = computed(() => store.bridgeIsSelf && isOwner.value);
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <!-- 브리지/연결 상태 -->
      <div class="card">
        <div class="card-header"><h3>📡 마스터 브리지</h3></div>
        <div class="card-body">
          <div class="wl-status">
            <span class="wl-dot" :class="store.bridge.online ? 'ok' : 'bad'"></span>
            <span v-if="store.bridgeIsSelf">이 PC가 브리지</span>
            <span v-else-if="store.bridge.online">브리지 온라인 (다른 PC)</span>
            <span v-else>브리지 오프라인</span>
          </div>
          <div class="wl-status">
            <span class="wl-dot" :class="connected ? 'ok' : 'bad'"></span>
            <span>{{ connected ? "서버 연결됨" : "서버 연결 끊김" }}</span>
          </div>
          <router-link to="/wireless" class="btn btn-ghost btn-block mt-1">설정 / 진단</router-link>
        </div>
      </div>

      <!-- 신호등 점유·제어 -->
      <div class="card">
        <div class="card-header"><h3>🚦 신호등 (점유)</h3></div>
        <div class="card-body">
          <div class="wl-lock">
            <span v-if="store.ownerKey">점유: {{ store.EVENT_TYPE[store.ownerKey] }}</span>
            <span v-else class="wl-muted">점유 없음</span>
          </div>
          <div class="btn-group">
            <button class="btn btn-success" :disabled="!canGreen" @click="store.greenFor(eventKey)">녹색등</button>
            <button class="btn btn-ghost" :disabled="!canControl || lightColor === 'grey'" @click="store.offFor(eventKey)">OFF</button>
            <button class="btn btn-danger" :disabled="!canControl || lightColor === 'red'" @click="store.redFor(eventKey)">적색등</button>
          </div>
          <button
            v-if="store.bridgeIsSelf && isOwner"
            class="btn btn-ghost btn-block mt-1"
            @click="store.release(eventKey)"
          >점유 해제</button>
          <p v-if="!store.bridgeIsSelf" class="wl-hint">신호등 제어는 브리지 PC에서만 가능합니다.</p>
        </div>
      </div>

      <!-- 경기 설정 -->
      <div class="card">
        <div class="card-header"><h3>⚙️ 경기 설정</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">이벤트 이름</label>
            <input v-model="slot.config.eventName" type="text" class="form-input" :disabled="isLocked" data-testid="wl-event-name" />
          </div>
          <slot name="teams" :locked="isLocked" />
          <slot name="actions" :locked="isLocked" />
          <button class="btn btn-warning btn-block mt-1" @click="store.resetFor(eventKey)">초기화</button>
        </div>
      </div>
    </aside>

    <section class="content">
      <div class="monitor-header">
        <h2 class="event-title">{{ titleText }}</h2>
      </div>

      <div class="timer-section card">
        <div class="timer-display">
          <span class="traffic-light" :class="lightColor"></span>
          <span class="clock">{{ slot.clockDisplay }}</span>
        </div>
      </div>

      <slot name="records" />
    </section>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";

.wl-status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; margin-bottom: 0.4rem; }
.wl-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.wl-dot.ok { background: var(--accent-success); box-shadow: 0 0 6px var(--accent-success); }
.wl-dot.bad { background: var(--accent-danger); }
.wl-lock { font-size: 0.9rem; margin-bottom: 0.5rem; }
.wl-muted { color: var(--text-tertiary); }
.wl-hint { font-size: 0.78rem; color: var(--text-tertiary); margin-top: 0.5rem; }
</style>
