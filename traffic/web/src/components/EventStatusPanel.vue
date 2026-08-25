<script setup>
import { ref } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { addRecord, deleteRecordRow, updateRecord } from "../composables/useApi";
import RecordStatusControl from "./RecordStatusControl.vue";

const props = defineProps({
  eventName: { type: String, default: "" },
  entry: { type: Object, default: null },
  eventType: { type: String, required: true },
  wireless: { type: Boolean, default: false },
  source: { type: Object, required: true },
  record: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["record", "update", "remove", "finalize"]);
const { notyf } = useNotification();
const busy = ref(false);

async function selectStatus(status) {
  if (busy.value || props.disabled) return;
  if (!props.eventName.trim() || !props.entry) {
    notyf.error("이벤트 이름과 팀을 선택하세요.");
    return;
  }
  busy.value = true;
  try {
    if (props.record) {
      const patch = await updateRecord(props.record.name, props.record.rowid, "status", status);
      emit("update", patch);
    } else if (props.wireless) {
      const created = await props.source.setStatus(status);
      emit("record", created);
    } else {
      const created = await addRecord(props.eventName.trim(), {
        time: new Date(),
        type: props.eventType,
        entry: {
          id: props.entry.id,
          num: props.entry.num,
          univ: props.entry.univ,
          team: props.entry.team,
        },
        result: null,
        status,
      });
      emit("record", created);
    }
    // A measured attempt stays finalized even when its special status is
    // restored to normal. Starting another attempt requires an explicit reset.
    emit("finalize", status != null || props.record?.result != null);
    notyf.success(`${status || "정상"} 판정을 저장했습니다.`);
  } catch (e) {
    notyf.error(`판정 저장 실패: ${e.message}`);
  } finally {
    busy.value = false;
  }
}

async function cancelStatus() {
  if (!props.record || busy.value || props.disabled) return;
  if (!window.confirm("측정시간이 없는 판정 기록을 삭제할까요?")) return;
  busy.value = true;
  try {
    await deleteRecordRow(props.record.name, props.record.rowid);
    emit("remove", { name: props.record.name, rowid: props.record.rowid });
    emit("finalize", false);
    notyf.success("판정 기록을 삭제했습니다.");
  } catch (e) {
    notyf.error(`판정 취소 실패: ${e.message}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="event-status-panel">
    <label>기록 판정</label>
    <RecordStatusControl
      :status="record?.status ?? null"
      :result="record?.result ?? null"
      :disabled="disabled || !eventName.trim() || !entry"
      :busy="busy"
      allow-cancel
      @select="selectStatus"
      @cancel="cancelStatus"
    />
  </div>
</template>

<style scoped>
.event-status-panel {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.9rem;
}

.event-status-panel label {
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 700;
}
</style>
