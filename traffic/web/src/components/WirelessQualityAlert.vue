<script setup>
import { computed, ref, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { useSSE } from "../composables/useSSE";

const { wirelessQualityFaults } = useSSE();
const { notyf } = useNotification();
const dismissed = ref(new Set());
const notified = new Set();
const roleLabel = { start: "출발", finish: "도착" };

const faults = computed(() => Object.values(wirelessQualityFaults.value || {})
  .filter((fault) => fault?.fault_id && !dismissed.value.has(fault.fault_id))
  .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))));

function title(fault) {
  return fault.kind === "measurement"
    ? `${fault.event_type} 기록 이상으로 자동 중단`
    : `${fault.event_type} 계측 품질 이상으로 자동 중단`;
}

function reasonText(reason) {
  const node = reason?.node_id === "0" ? "마스터"
    : reason?.node_id ? `센서 ${reason.node_id}` : "";
  const role = reason?.role ? `/${roleLabel[reason.role] || reason.role}` : "";
  return `${node}${role}${node || role ? ": " : ""}${reason?.reason || "원인을 확인할 수 없습니다."}`;
}

function occurredAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR");
}

function dismiss(faultId) {
  dismissed.value = new Set([...dismissed.value, faultId]);
}

watch(
  () => Object.values(wirelessQualityFaults.value || {}).map((fault) => fault?.fault_id).filter(Boolean).sort().join("|"),
  () => {
    for (const fault of Object.values(wirelessQualityFaults.value || {})) {
      if (!fault?.fault_id || notified.has(fault.fault_id)) continue;
      notified.add(fault.fault_id);
      const reason = fault.reasons?.[0]?.reason;
      notyf.error(reason ? `${title(fault)}: ${reason}` : title(fault));
    }
  },
  { immediate: true },
);
</script>

<template>
  <section v-if="faults.length" class="quality-alerts" aria-live="assertive">
    <article
      v-for="fault in faults"
      :key="fault.fault_id"
      class="quality-alert"
      role="alert"
      :data-testid="`wireless-quality-fault-${fault.event_type}`"
    >
      <div class="quality-alert-icon" aria-hidden="true">⚠️</div>
      <div class="quality-alert-content">
        <strong>{{ title(fault) }}</strong>
        <time v-if="occurredAt(fault.occurred_at)" :datetime="fault.occurred_at">{{ occurredAt(fault.occurred_at) }}</time>
        <ul>
          <li v-for="(reason, index) in fault.reasons || []" :key="`${fault.fault_id}-${index}`">
            {{ reasonText(reason) }}
          </li>
        </ul>
      </div>
      <button class="quality-alert-dismiss" type="button" aria-label="경고 닫기" @click="dismiss(fault.fault_id)">
        확인
      </button>
    </article>
  </section>
</template>

<style scoped>
.quality-alerts {
  position: sticky;
  top: 0;
  z-index: 100;
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem max(1rem, calc((100vw - 1400px) / 2));
  pointer-events: none;
}
.quality-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  border: 1px solid rgba(239, 68, 68, 0.65);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-primary) 90%, #ef4444 10%);
  box-shadow: 0 4px 16px rgba(127, 29, 29, 0.2);
  color: var(--text-primary);
  pointer-events: auto;
}
.quality-alert-icon { line-height: 1.4; }
.quality-alert-content { flex: 1; min-width: 0; }
.quality-alert-content strong { color: var(--accent-danger, #ef4444); }
.quality-alert-content time { display: block; margin-top: 0.15rem; color: var(--text-tertiary); font-size: 0.8rem; }
.quality-alert-content ul { margin: 0.35rem 0 0; padding-left: 1.25rem; }
.quality-alert-content li { margin-top: 0.15rem; }
.quality-alert-dismiss {
  flex: 0 0 auto;
  border: 1px solid rgba(239, 68, 68, 0.45);
  border-radius: 7px;
  padding: 0.35rem 0.7rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.quality-alert-dismiss:hover { background: rgba(239, 68, 68, 0.12); }
</style>
