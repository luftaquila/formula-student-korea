import {
  CAPTURE_CHECKPOINT,
  WIRELESS_PROTOCOL_VERSION,
  verifyCaptures,
} from "../../lib/wireless-capture-integrity.mjs";
import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";
import {
  masterTickDurationsMs,
  formatEnduranceDetail,
  masterTickDistanceBelowMs,
  masterTickDelta,
  masterTickDeltaMs,
} from "../../lib/event-timing.mjs";

export function createTimingService({
  broadcastSSEEvent,
  options,
  db,
  dbRun,
  liveTelemetry,
  commitBridgeSeen,
  getLastEventId,
  getMapping,
  telemetryAgeMs,
  WIRELESS_STATUS_MAX_AGE_MS,
  validateRecordName,
  validateRecordData,
  insertRecordRow,
  logger,
  SYS_ACTOR,
  getRecordFiles,
  getRecordRow,
  publishWirelessQualityFault,
  getSessions,
  getDebounceMs,
  clearWirelessQualityFault,
  getSession,
}) {
  let timingContext = null;

  function broadcastEvent(event, data) {
    if (timingContext) {
      timingContext.notifications.push([event, structuredClone(data)]);
      return;
    }
    broadcastSSEEvent(event, data);
    options.onEvent?.(event, data);
  }

  /* ── 서버 권위 기록 엔진 ──────────────────────────────────────────────
   * ingest로 들어온 타이밍 이벤트를 매핑·세션으로 라우팅해 서버가 직접 기록을 계산·저장한다.
   * 가속·오토크로스는 출발→도착, 스키드패드는 lap2+lap4. 원시 tick 기준으로 검증한다.
   * 팀·이벤트가 선택되지 않은 테스트 계측도 같은 서버 결과를 표시하되 기록 행은 저장하지 않는다.
   */
  function clockStr(ms) {
    if (ms < 0) ms = 0;
    const m = String(Math.floor(ms / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    const ms3 = String(ms % 1000).padStart(3, "0");
    return `${m}:${s}.${ms3}`;
  }

  // SQLite owns run state. A request edits only its local drafts; failed writes
  // discard them without restoring caches or attempting another database write.
  function encodeRun(run) {
    return JSON.stringify(run, (_key, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
  }

  function getRun(eventType) {
    if (timingContext?.runs.has(eventType)) return timingContext.runs.get(eventType);
    const row = db
      .prepare("SELECT run_id, engine_state FROM wireless_session WHERE event_type = ?")
      .get(eventType);
    let run = row?.engine_state ? JSON.parse(row.engine_state) : null;
    if (run?.runId !== row?.run_id) run = null;
    if (run) {
      run.lapTicks = (run.lapTicks || []).map(BigInt);
    }
    if (timingContext) timingContext.runs.set(eventType, run);
    return run;
  }

  function setRun(eventType, run) {
    if (!timingContext) throw new Error("Run changes require a timing transaction");
    timingContext.runs.set(eventType, run);
  }

  function timingTransaction(work) {
    if (timingContext) throw new Error("Nested timing transaction");
    const context = { runs: new Map(), telemetry: new Map(), bridge: null, notifications: [] };
    timingContext = context;
    const result = dbRun(() =>
      db.transaction(() => {
        const value = work();
        const update = db.prepare(
          "UPDATE wireless_session SET engine_state = ? WHERE event_type = ? AND engine_state IS NOT ?",
        );
        for (const [eventType, run] of context.runs) {
          const encoded = run ? encodeRun(run) : null;
          update.run(encoded, eventType, encoded);
        }
        return value;
      })(),
    );
    timingContext = null;
    if (result.success) {
      for (const [node, state] of context.telemetry) liveTelemetry.set(node, state);
      if (context.bridge) commitBridgeSeen(context.bridge);
      for (const [event, data] of context.notifications) broadcastEvent(event, data);
    }
    return result;
  }

  function resetEngineRun(eventType, bound = null, runId = null, clock = null) {
    const nodes = {};
    let cursorId = getLastEventId();
    if (clock) {
      for (const mapping of getMapping().filter(
        (row) => row.event_type === eventType && row.enabled !== 0,
      )) {
        const checkpoints = db
          .prepare(
            "SELECT * FROM wireless_event WHERE node_id = ? AND master_boot_id = ? AND (flags & ?) != 0 ORDER BY id DESC",
          )
          .all(mapping.node_id, clock.master_boot_id, CAPTURE_CHECKPOINT);
        const checkpoint = checkpoints.find(
          (row) => BigInt(row.master_tick) <= BigInt(clock.master_tick),
        );
        const currentBoot = liveTelemetry.get(String(mapping.node_id))?.sensor_boot_id;
        if (
          !checkpoint ||
          (currentBoot != null && checkpoint.sensor_boot_id !== currentBoot) ||
          (checkpoint.flags & 15) !== 15 ||
          telemetryAgeMs({ last_seen: checkpoint.server_time }) > WIRELESS_STATUS_MAX_AGE_MS
        ) {
          const error = new Error(
            `${mapping.node_id} 센서의 최신 캡처 확인을 기다린 뒤 다시 시작하세요.`,
          );
          error.status = 409;
          throw error;
        }
        nodes[mapping.node_id] = {
          boot: checkpoint.sensor_boot_id,
          seq: checkpoint.capture_seq,
          role: mapping.role,
        };
        cursorId = Math.min(cursorId, checkpoint.id);
      }
    }
    setRun(eventType, {
      version: WIRELESS_PROTOCOL_VERSION,
      runId,
      boundaryTick: clock?.master_tick ?? null,
      masterBootId: clock?.master_boot_id ?? null,
      nodes,
      cursorId,
      bound,
      closed: false,
      verification: "pending",
      lapTicks: [],
      result: null,
      recordName: null,
      recordRowid: null,
    });
  }

  // 동적 기록 테이블에 한 줄 저장 + records 브로드캐스트.
  // binding = 귀속 정보 {team, event_name}: arm 스냅샷(run.bound) 또는 live 세션.
  // 선택 정보(team·event_name) 자체가 없으면 = 테스트 모드 → 조용히 skip(경고 없음).
  // 선택은 됐는데 검증 실패(잘못된 팀/이름) → warn 로그(유선의 POST /api/records와 동일 검증).
  function engineSaveRecord(eventType, binding, result, detail, audit = null, status = null) {
    if (!binding?.event_name || !binding?.team) return false;
    const nameCheck = validateRecordName(binding.event_name);
    if (!nameCheck.valid) throw new Error(nameCheck.error);
    const data = {
      time: new Date().toISOString(),
      type: eventType,
      entry: binding.team,
      result,
      status,
      detail,
    };
    const valid = validateRecordData(data, { allowRoundedZero: true });
    if (!valid.valid) throw new Error(valid.error);
    const name = `FSK ${currentCompetitionYear()} ${nameCheck.value}`;
    const run = getRun(eventType);
    const record = insertRecordRow(name, data);
    run.recordName = name;
    run.recordRowid = record.rowid;
    db.prepare(
      "UPDATE wireless_session SET saved_record_name = ?, saved_record_rowid = ? WHERE event_type = ? AND run_id = ?",
    ).run(name, record.rowid, eventType, run.runId);
    logger.log(
      audit?.req ?? null,
      "wireless.record",
      { type: eventType, run_id: run.runId, after: record },
      name,
      audit?.req ? undefined : SYS_ACTOR,
    );
    broadcastEvent("records", {
      type: "add",
      name,
      recordFiles: getRecordFiles(),
      record,
      event_type: eventType,
      run_id: run.runId,
    });
    return { name, record };
  }

  function enduranceUpsertRecord(eventType, binding, run) {
    if (!binding?.event_name || !binding?.team || !run.lapTicks.length) return;
    const total = masterTickDurationsMs(run.lapTicks);
    const detail = formatEnduranceDetail(
      run.lapTicks.map((ticks) => masterTickDurationsMs([ticks])),
    );
    const before = run.recordName && getRecordRow(run.recordName, run.recordRowid);
    if (!before) {
      engineSaveRecord(eventType, binding, total, detail);
      return;
    }
    if (before.result === total && before.detail === detail) return;
    db.prepare("UPDATE record SET result = ?, detail = ? WHERE name = ? AND legacy_rowid = ?").run(
      total,
      detail,
      run.recordName,
      run.recordRowid,
    );
    const after = getRecordRow(run.recordName, run.recordRowid);
    logger.log(
      null,
      "wireless.record",
      { event_type: eventType, run_id: run.runId, before, after },
      run.recordName,
      SYS_ACTOR,
    );
    broadcastEvent("records", {
      type: "update",
      name: run.recordName,
      field: "result",
      recordFiles: getRecordFiles(),
      record: after,
      event_type: eventType,
      run_id: run.runId,
    });
  }

  function invalidateRun(eventType, run, reasons, { awaitEvidence = false } = {}) {
    // Disarming blocks a new interval; closing also prevents late proof recovery.
    run.closed = !awaitEvidence;
    run.verification = "invalid";
    db.prepare("UPDATE wireless_session SET armed = 0 WHERE event_type = ? AND armed != 0").run(
      eventType,
    );
    if (!run.fault) {
      publishWirelessQualityFault(eventType, run.runId, reasons);
      logger.warn(
        null,
        "wireless.quality_fault",
        { error: reasons[0]?.reason, event_type: eventType, run_id: run.runId, reasons },
        eventType,
        SYS_ACTOR,
      );
    }
  }

  function processRecordEngine(rows, onlyEventType = null) {
    if (!rows.length) return;
    for (const session of getSessions()) {
      const et = session.event_type;
      if (onlyEventType && et !== onlyEventType) continue;
      const run = getRun(et);
      if (!run) {
        if (session.armed) throw new Error("진행 중인 계측의 영속 상태가 없습니다.");
        continue;
      }
      if (run.closed || !rows.some((row) => run.nodes[row.node_id] || row.node_id === "0"))
        continue;
      const evidence = db
        .prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id")
        .all(run.cursorId);
      const verified = verifyCaptures(run, evidence);
      const debounce = {};
      const accepted = verified.events.filter((ev) => {
        const last = debounce[ev.node_id];
        if (last != null && masterTickDistanceBelowMs(ev.master_tick, last, getDebounceMs()))
          return false;
        debounce[ev.node_id] = ev.master_tick;
        return true;
      });
      let result = null;
      let detail = null;
      let complete = false;
      let invalidDuration = false;
      const laps = [];
      if (et === "내구" || et === "스키드패드") {
        const crossings = accepted.filter((ev) => ev.role === "start");
        for (let i = 1; i < crossings.length; i++) {
          const duration = masterTickDelta(crossings[i].master_tick, crossings[i - 1].master_tick);
          if (duration <= 0n) {
            invalidDuration = true;
            break;
          }
          laps.push(duration);
        }
        if (et === "내구" && laps.length) result = masterTickDurationsMs(laps);
        if (et === "스키드패드" && laps.length >= 4) {
          result = masterTickDurationsMs([laps[1], laps[3]]);
          detail = `${clockStr(masterTickDurationsMs([laps[1]]))} / ${clockStr(masterTickDurationsMs([laps[3]]))}`;
          complete = true;
        }
      } else {
        const start = accepted.find((ev) => ev.role === "start");
        const finish = accepted.find((ev) => ev.role === "finish");
        if (start && finish) {
          const duration = masterTickDelta(finish.master_tick, start.master_tick);
          invalidDuration = duration <= 0n;
          if (!invalidDuration) {
            result = masterTickDeltaMs(finish.master_tick, start.master_tick);
            complete = true;
          }
        }
      }
      run.lapTicks = laps;
      run.result = result;
      run.verification =
        !complete && run.fault ? "invalid" : result == null ? "pending" : "verified";
      if (result != null && !invalidDuration) {
        if (et === "내구") enduranceUpsertRecord(et, run.bound, run);
        else if (complete) engineSaveRecord(et, run.bound, result, detail);
      }
      if (complete) {
        run.closed = true;
        if (run.fault) clearWirelessQualityFault(et);
      }
      // A completed, verified interval before a later fault stays official.
      if (!complete && (verified.fault || invalidDuration)) {
        invalidateRun(
          et,
          run,
          [
            verified.fault || {
              node_id: null,
              reason: "출발·도착의 원시 시간차가 양수가 아닙니다.",
            },
          ],
          { awaitEvidence: !!verified.fault && !invalidDuration },
        );
      }
      broadcastEvent("wireless:session", getSession(et));
    }
  }

  return {
    readTimingContext: () => timingContext,
    broadcastEvent,
    getRun,
    setRun,
    timingTransaction,
    resetEngineRun,
    engineSaveRecord,
    invalidateRun,
    processRecordEngine,
  };
}
