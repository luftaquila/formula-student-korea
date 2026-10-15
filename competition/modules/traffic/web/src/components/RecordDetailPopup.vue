<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { formatLapMs } from "@lib/event-timing.mjs";

// 내구 detail은 타이밍 엔진이 쓰는 랩 목록이라 편집하지 않고 랩 표로만 보여준다.
const ENDURANCE_TYPE = "내구";

const props = defineProps({
  record: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(["save", "close"]);

const savedDetail = computed(() => props.record.detail || "");
const draft = ref(savedDetail.value);
// 다른 운영자의 저장(SSE)은 손대지 않은 초안에만 반영한다. 수정 중인 초안은 유지한다.
watch(savedDetail, (next, previous) => {
  if (draft.value === previous) draft.value = next;
});
const editable = computed(() => props.record.type !== ENDURANCE_TYPE);
const dirty = computed(() => editable.value && draft.value !== savedDetail.value);
const resultLabel = computed(() =>
  Number.isInteger(props.record.result) && props.record.result > 0 ? formatLapMs(props.record.result) : "—",
);

function clockToMs(s) {
  const m = /^(\d+):(\d{2})\.(\d{3})$/.exec((s || "").trim());
  return m ? (+m[1]) * 60000 + (+m[2]) * 1000 + (+m[3]) : null;
}

const enduranceDetail = computed(() => {
  if (props.record.type !== ENDURANCE_TYPE || !props.record.detail) return null;
  const parsed = props.record.detail.split("/").map(clockToMs);
  const list = parsed.filter((n) => n != null);
  if (!list.length) return { laps: null, complete: false };
  let best = list[0], bestIdx = 0, sum = 0;
  list.forEach((ms, i) => { sum += ms; if (ms < best) { best = ms; bestIdx = i; } });
  const laps = { list, count: list.length, best, bestIdx: bestIdx + 1, avg: Math.round(sum / list.length), total: sum };
  return { laps, complete: list.length === parsed.length };
});
const laps = computed(() => enduranceDetail.value?.laps ?? null);
// 랩마다 직전 랩 대비 차이(ms)를 함께 둔다. 음수면 빨라진 것이다.
const lapRows = computed(() => (laps.value?.list ?? []).map((ms, i, list) => ({
  no: i + 1,
  ms,
  delta: i > 0 ? ms - list[i - 1] : null,
  best: i + 1 === laps.value.bestIdx,
})));
// 랩으로 읽지 못한 부분(수동 메모 등)이 있으면 원문을 그대로 보여준다.
const showRawDetail = computed(() => enduranceDetail.value != null && !enduranceDetail.value.complete);

function formatDelta(ms) {
  const sign = ms > 0 ? "+" : ms < 0 ? "-" : "±";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

function deltaClass(ms) {
  if (ms == null || ms === 0) return "";
  return ms < 0 ? "faster" : "slower";
}

function save() {
  if (!dirty.value || props.busy) return;
  emit("save", draft.value);
}

function close() {
  if (dirty.value && !window.confirm("저장하지 않은 상세 내용을 버릴까요?")) return;
  emit("close");
}

function focusOnMount(el) {
  if (el) el.focus();
}

function onKeydown(event) {
  if (event.key === "Escape") close();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="record-popup-overlay" @click.self="close">
    <div class="record-popup" role="dialog" aria-modal="true" aria-label="기록 상세" data-testid="record-detail-popup">
      <div class="record-popup-header">
        <div class="record-popup-titles">
          <h3>#{{ record.num }} {{ record.univ }} {{ record.team }}</h3>
          <p class="record-popup-meta">
            {{ record.type }} · {{ resultLabel }}<template v-if="record.status"> · {{ record.status }}</template>
          </p>
        </div>
        <button type="button" class="record-popup-close" title="닫기" @click="close">✕</button>
      </div>

      <form v-if="editable" class="record-popup-body" @submit.prevent="save">
        <label class="form-label" for="record-detail-input">상세</label>
        <input
          id="record-detail-input"
          :ref="focusOnMount"
          v-model="draft"
          type="text"
          class="form-input"
          placeholder="상세 내용 입력"
          :disabled="busy"
          data-testid="record-detail-input"
        />
        <div class="record-popup-actions">
          <button type="button" class="btn btn-ghost" @click="close">취소</button>
          <button type="submit" class="btn btn-primary" :disabled="busy || !dirty" data-testid="record-detail-save">저장</button>
        </div>
      </form>

      <template v-else>
        <template v-if="laps">
          <div class="lap-stats">
            <div class="lps-item"><span class="lps-k">총 랩</span><span class="lps-v">{{ laps.count }}</span></div>
            <div class="lps-item"><span class="lps-k">최고 랩</span><span class="lps-v">{{ formatLapMs(laps.best) }} (#{{ laps.bestIdx }})</span></div>
            <div class="lps-item"><span class="lps-k">평균 랩</span><span class="lps-v">{{ formatLapMs(laps.avg) }}</span></div>
            <div class="lps-item"><span class="lps-k">총 시간</span><span class="lps-v">{{ formatLapMs(laps.total) }}</span></div>
          </div>
          <div class="lap-list">
            <div
              v-for="lap in lapRows"
              :key="lap.no"
              class="lap-row"
              :class="{ best: lap.best }"
            >
              <span class="lpr-no">Lap {{ lap.no }}</span>
              <span class="lpr-t">{{ formatLapMs(lap.ms) }}</span>
              <span class="lpr-delta" :class="deltaClass(lap.delta)">{{ lap.delta == null ? "-" : formatDelta(lap.delta) }}</span>
              <span class="lpr-tag">{{ lap.best ? "BEST" : "" }}</span>
            </div>
          </div>
        </template>

        <div v-if="showRawDetail" class="record-popup-raw" data-testid="record-detail-raw">{{ record.detail }}</div>
        <p v-if="!laps && !showRawDetail" class="record-popup-empty">상세 없음</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.record-popup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.record-popup {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card), 0 12px 40px rgba(0, 0, 0, 0.4);
  width: 100%;
  max-width: 420px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.record-popup-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.record-popup-titles {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.record-popup-header h3 {
  font-size: 1rem;
  font-weight: 700;
}
.record-popup-meta {
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.875rem;
}
.record-popup-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.25rem;
  flex-shrink: 0;
}
.record-popup-close:hover {
  color: var(--text-primary);
}
.record-popup-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem 1.25rem 1.25rem;
}
.record-popup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.record-popup-raw {
  flex-shrink: 0;
  max-height: 30vh;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  color: var(--text-primary);
  font-size: 0.875rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.lap-list + .record-popup-raw {
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.record-popup-empty {
  padding: 1.25rem;
  color: var(--text-tertiary);
  text-align: center;
}
.lap-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.lps-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.lps-k {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}
.lps-v {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--text-primary);
}
.lap-list {
  overflow-y: auto;
  padding: 0.5rem 1.25rem 1rem;
}
.lap-row {
  display: grid;
  /* 고정폭 글꼴 기준 고정 트랙이라 모든 행의 열 위치와 간격이 같다. */
  grid-template-columns: 6ch 9ch 7ch 4ch;
  justify-content: space-between;
  column-gap: 1rem;
  align-items: center;
  padding: 0.4rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-family: "JetBrains Mono", monospace;
}
.lpr-no {
  color: var(--text-secondary);
  font-weight: 600;
}
.lpr-t {
  font-weight: 700;
  color: var(--text-primary);
}
.lpr-delta {
  text-align: right;
  font-weight: 600;
  color: var(--text-tertiary);
}
.lpr-delta.faster {
  color: var(--accent-success);
}
.lpr-delta.slower {
  color: var(--accent-danger);
}
.lpr-tag {
  text-align: right;
  font-weight: 800;
  color: var(--accent-success);
}
.lap-row.best .lpr-t {
  color: var(--accent-success);
}
</style>
