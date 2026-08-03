import { ref, watch } from "vue";
import { useSSE } from "./useSSE";
import { fetchRecord } from "./useApi";

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
  matchesRecovery = matchesRun,
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

  // 무선 내구처럼 한 행을 계속 UPDATE하는 경기는 첫 INSERT 이후 화면을 열면 add SSE를
  // 볼 수 없다. 현재 arm 시각 이후의 같은 팀·종목 행을 조회해 카드를 복구한다.
  async function recoverRecord() {
    if (recentRecord.value || !wireless() || !active() || !acceptingRecord) return;

    const token = runToken;
    const name = expectedName();
    const type = eventType();
    const num = Number(teamNum());
    const runStartedAt = Date.parse(startedAt());
    if (!name || !Number.isFinite(num) || !Number.isFinite(runStartedAt)) return;

    let rows;
    try {
      rows = await fetchRecord(name);
    } catch {
      // 아직 첫 랩이 저장되지 않았거나 이벤트명이 유효하지 않은 경우. 이후 add SSE가 연다.
      return;
    }

    // 조회 중 OFF/초기화/새 런으로 넘어갔다면 이전 행을 다시 노출하지 않는다. 적색등은
    // endRun이 아니므로 조회가 끝날 때 active=false여도 이번 기록 카드는 복구한다.
    if (token !== runToken || !acceptingRecord || recentRecord.value) return;

    const record = [...rows].reverse().find((row) => {
      const recordTime = Date.parse(row.time);
      return row.type === type &&
        Number(row.num) === num &&
        Number.isFinite(recordTime) &&
        recordTime >= runStartedAt &&
        matchesRecovery(row);
    });
    if (record) captureRecord({ name, record }, token);
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
    // 적색등은 기록 확인 단계이므로 active=false가 되어도 add를 받아야 한다. OFF/초기화는
    // endRun이 acceptingRecord를 닫고, 다음 런의 오래된 add는 armed_at 비교가 차단한다.
    if (!acceptingRecord || !wireless() || update.type !== "add") return;
    if (update.name !== expectedName()) return;
    if (update.record.type !== eventType()) return;
    if (Number(update.record.num) !== Number(teamNum())) return;
    const runStartedAt = Date.parse(startedAt());
    const recordTime = Date.parse(update.record.time);
    if (Number.isFinite(runStartedAt) && Number.isFinite(recordTime) && recordTime < runStartedAt) return;
    if (!matchesRun(update.record)) return;

    captureRecord(update);
  });

  return {
    recentRecord,
    captureRecord,
    mergeRecord,
    clearRecord,
    beginRun,
    endRun,
    getRunToken,
    recoverRecord,
  };
}
