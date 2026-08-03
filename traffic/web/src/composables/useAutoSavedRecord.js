import { ref, watch } from "vue";
import { useSSE } from "./useSSE";

// 계측 화면에서 방금 자동 저장된 행만 추적한다.
// 유선은 POST 응답을 captureRecord로 직접 넘기고, 무선은 서버 기록 엔진의 records SSE를
// 현재 런(이벤트명·팀·종목·결과)과 대조해 같은 행을 찾는다.
export function useAutoSavedRecord({
  wireless,
  active = () => true,
  startedAt = () => null,
  expectedName,
  eventType,
  teamNum,
  matchesRun,
}) {
  const { lastUpdate } = useSSE();
  const recentRecord = ref(null);
  let acceptingRecord = !!active();
  let runToken = 0;

  function captureRecord(payload, token = runToken) {
    if (token !== runToken || !acceptingRecord || !payload?.name || !payload?.record) return;
    recentRecord.value = { name: payload.name, ...payload.record };
  }

  function mergeRecord(patch) {
    if (!recentRecord.value || !patch) return;
    recentRecord.value = { ...recentRecord.value, ...patch };
  }

  function clearRecord() {
    recentRecord.value = null;
  }

  function beginRun() {
    runToken += 1;
    acceptingRecord = true;
    clearRecord();
  }

  function endRun() {
    runToken += 1;
    acceptingRecord = false;
    clearRecord();
  }

  function getRunToken() {
    return runToken;
  }

  watch(lastUpdate, (update) => {
    if (!update?.name || !update?.record) return;

    // 이 카드에서 저장한 수정이나 내구의 후속 랩 갱신을 최신 상태로 반영한다.
    if (
      recentRecord.value &&
      update.name === recentRecord.value.name &&
      update.record.rowid === recentRecord.value.rowid
    ) {
      mergeRecord(update.record);
      return;
    }

    // 새 카드는 자동 INSERT에만 열어 둔다. UPDATE나 카드가 닫힌 뒤 늦게 도착한 수정 SSE가
    // 이전 카드를 되살리지 않게 한다.
    if (!acceptingRecord || !active() || !wireless() || update.type !== "add") return;
    if (update.name !== expectedName()) return;
    if (update.record.type !== eventType()) return;
    if (Number(update.record.num) !== Number(teamNum())) return;
    const runStartedAt = Date.parse(startedAt());
    const recordTime = Date.parse(update.record.time);
    if (Number.isFinite(runStartedAt) && Number.isFinite(recordTime) && recordTime < runStartedAt) return;
    if (!matchesRun(update.record)) return;

    captureRecord(update);
  });

  return { recentRecord, captureRecord, mergeRecord, clearRecord, beginRun, endRun, getRunToken };
}
