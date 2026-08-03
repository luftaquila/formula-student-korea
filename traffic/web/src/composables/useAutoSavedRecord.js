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

  // records SSE가 끊긴 사이 저장됐거나 저장 후 화면을 연 경우에도 세션에 보관된 정확한
  // name/rowid를 조회해 같은 런의 편집 카드를 복구한다.
  async function recoverRecord() {
    if (recentRecord.value || !wireless() || !acceptingRecord) return;

    const token = runToken;
    const currentSession = session();
    const runId = currentSession?.run_id;
    const name = currentSession?.saved_record_name;
    const rowid = Number(currentSession?.saved_record_rowid);
    if (!runId || !name || !Number.isInteger(rowid)) return;

    let rows;
    try {
      rows = await fetchRecord(name);
    } catch {
      // 기록이 삭제됐거나 아직 조회할 수 없는 경우. 이후 세션/records 갱신에서 재시도한다.
      return;
    }

    // 조회 중 OFF/초기화/새 런으로 넘어갔다면 이전 행을 다시 노출하지 않는다.
    if (token !== runToken || !acceptingRecord || recentRecord.value || session()?.run_id !== runId) return;

    const record = rows.find((row) => Number(row.rowid) === rowid);
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

    // 새 카드는 서버 기록 엔진이 현재 세션 run_id로 발행한 INSERT만 연다. 수동 추가에는
    // run_id가 없고 과거 런의 지연 이벤트는 id가 다르므로 잘못된 행을 잡지 않는다.
    if (!acceptingRecord || !wireless() || update.type !== "add") return;
    if (!update.run_id || update.run_id !== session()?.run_id) return;

    captureRecord(update);
  });

  // 무선 카드 수명주기는 낙관적 로컬 신호등이 아니라 서버 세션을 따른다. 새 run_id가
  // 확정되면 열고, red에서는 유지하며, off가 확정된 뒤에만 닫는다.
  watch(() => session(), (currentSession) => {
    if (!wireless()) return;
    const runId = currentSession?.run_id ?? null;
    const open = !!runId && currentSession?.light_color !== "off";

    if (runId !== trackedRunId) {
      trackedRunId = runId;
      if (open) beginRun();
    }

    if (!open) {
      if (acceptingRecord) endRun();
      return;
    }

    if (!acceptingRecord) {
      runToken += 1;
      acceptingRecord = true;
      clearRecord();
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
