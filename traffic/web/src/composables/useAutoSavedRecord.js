import { ref, watch } from "vue";
import { useSSE } from "./useSSE";
import { fetchRecord } from "./useApi";

// 계측 화면에서 방금 자동 저장된 행만 추적한다.
// 유선은 POST 응답을 직접 받고, 무선은 서버가 세션에 기록한 run_id + 행 식별자로 연결한다.
// 표시값 조합으로 추측하지 않으므로 같은 팀·결과의 수동 기록이 편집 대상을 가로챌 수 없다.
export function useAutoSavedRecord({
  wireless,
  session = () => null,
}) {
  const { lastUpdate } = useSSE();
  const recentRecord = ref(null);
  let acceptingRecord = !wireless();
  let runToken = 0;
  let trackedRunId = null;
  let dismissedRunId = null;

  function assignRecord(payload) {
    if (!payload?.name || !payload?.record) return;
    recentRecord.value = { name: payload.name, ...payload.record };
  }

  function captureRecord(payload, token = runToken) {
    if (token !== runToken || !acceptingRecord || !payload?.name || !payload?.record) return;
    assignRecord(payload);
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
    dismissedRunId = null;
    clearRecord();
  }

  // 명시적인 초기화는 현재 기록을 폐기한다. 일반 OFF/red는 아래 세션 watcher에서
  // 수신만 닫고 카드는 유지하므로 다음 측정 전까지 계속 편집할 수 있다.
  function endRun() {
    runToken += 1;
    acceptingRecord = false;
    if (wireless()) dismissedRunId = trackedRunId;
    clearRecord();
  }

  function getRunToken() {
    return runToken;
  }

  // records SSE가 끊긴 사이 저장됐거나 저장 후 화면을 연 경우에도 세션에 보관된 정확한
  // name/rowid를 조회해 같은 런의 편집 카드를 복구한다.
  async function recoverRecord() {
    if (recentRecord.value || !wireless()) return;

    const token = runToken;
    const currentSession = session();
    const runId = currentSession?.run_id;
    const name = currentSession?.saved_record_name;
    const rowid = Number(currentSession?.saved_record_rowid);
    if (!runId || dismissedRunId === runId || !name || !Number.isInteger(rowid)) return;

    let rows;
    try {
      rows = await fetchRecord(name);
    } catch {
      // 기록이 삭제됐거나 아직 조회할 수 없는 경우. 이후 세션/records 갱신에서 재시도한다.
      return;
    }

    // 조회 중 초기화/새 런으로 넘어갔다면 이전 행을 다시 노출하지 않는다. 일반 OFF/red는
    // 편집 카드를 유지해야 하므로 복구를 허용하되 새 records 이벤트 수신은 닫힌 상태다.
    if (
      token !== runToken ||
      recentRecord.value ||
      session()?.run_id !== runId ||
      dismissedRunId === runId
    ) return;

    const record = rows.find((row) => Number(row.rowid) === rowid);
    if (record) assignRecord({ name, record });
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

    // 새 카드는 서버 기록 엔진이 현재 세션 run_id로 발행한 INSERT만 연다. 수동 추가에는
    // run_id가 없고 과거 런의 지연 이벤트는 id가 다르므로 잘못된 행을 잡지 않는다.
    if (!acceptingRecord || !wireless() || update.type !== "add") return;
    if (!update.run_id || update.run_id !== session()?.run_id) return;

    captureRecord(update);
  });

  // 새 run_id에서만 수신을 연다. 같은 런의 red/off가 확정되면 수신은 단방향으로 닫되
  // 편집 카드는 유지한다. 이후 같은 run_id로 색만 바뀌어도 다시 열지 않으며, 다음 green은
  // 새 run_id를 발급하므로 그때 이전 카드를 지운다.
  watch(() => session(), (currentSession) => {
    if (!wireless()) return;
    const runId = currentSession?.run_id ?? null;
    const active = !!runId && !!currentSession?.armed && currentSession?.light_color === "green";

    if (runId !== trackedRunId) {
      trackedRunId = runId;
      runToken += 1;
      acceptingRecord = active;
      dismissedRunId = null;
      clearRecord();
    } else if (!active && acceptingRecord) {
      // OFF/red 이후의 지연 이벤트를 받지 않도록 토큰을 닫는다. 카드는 명시적 초기화 전까지 유지한다.
      runToken += 1;
      acceptingRecord = false;
    }

    recoverRecord();
  }, { immediate: true, deep: true });

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
