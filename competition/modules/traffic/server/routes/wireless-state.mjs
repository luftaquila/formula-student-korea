import { EVENT_TYPES, RESULT_STATUSES } from "../../../../../shared/common/constants.js";
import crypto from "node:crypto";
import { isTeamActive } from "../../../../lib/team-status.mjs";

export function registerWirelessStateRoutes({
  app,
  rejectMutation,
  runMutationPreflight,
  getSession,
  wirelessActor,
  controllerEmail,
  timingTransaction,
  getRun,
  db,
  resetEngineRun,
  getRecordRow,
  recordYearFromName,
  currentRecordYear,
  broadcastEvent,
  getRecordFiles,
  engineSaveRecord,
  logger,
  dbRun,
  getLightState,
  getMapping,
  getLiveTelemetry,
  getBridgeState,
  getSessions,
  getLiveQualityFaults,
  getLastEventId,
}) {
  // POST /api/wireless/status - 현재 선택/런을 DNS·DNF·DSQ로 확정한다.
  // arm 단계와 무관하게 허용하되, 저장된/부분 행이 있으면 같은 행을 갱신해 중복 시도를 만들지 않는다.
  app.post("/api/wireless/status", (req, res) => {
    const { event_type, status } = req.body || {};
    if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
      return rejectMutation(req, res, {
        action: "wireless.status",
        status: 400,
        message: "올바르지 않은 종목입니다.",
        target: typeof event_type === "string" ? event_type : "wireless",
        operation: "classify",
        context: { event_type: event_type ?? null, requested_status: status ?? null },
      });
    }
    if (!RESULT_STATUSES.includes(status)) {
      return rejectMutation(req, res, {
        action: "wireless.status",
        status: 400,
        message: "판정은 DNS, DNF, DSQ 중 하나여야 합니다.",
        target: typeof event_type === "string" ? event_type : "wireless",
        operation: "classify",
        context: { event_type: event_type ?? null, requested_status: status ?? null },
      });
    }
    const sessionPreflight = runMutationPreflight(req, res, {
      action: "wireless.status",
      operation: "classify",
      target: event_type,
      context: { event_type, requested_status: status },
      lookup: () => getSession(event_type),
      failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
    });
    if (!sessionPreflight.ok) return;
    const sess = sessionPreflight.value;
    const actor = wirelessActor(req);
    if (sess?.controller && sess.controller !== actor) {
      const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
      return rejectMutation(req, res, {
        action: "wireless.status",
        status: 409,
        message,
        target: event_type,
        operation: "classify",
        context: {
          event_type,
          controller: controllerEmail(sess.controller),
          requested_actor: actor,
          team: sess.team ?? null,
          requested_status: status,
        },
      });
    }
    if (!sess?.event_name || !sess?.team) {
      return rejectMutation(req, res, {
        action: "wireless.status",
        status: 400,
        message: "이벤트 이름과 팀을 먼저 선택하세요.",
        target: event_type,
        operation: "classify",
        context: {
          event_type,
          team: sess?.team ?? null,
          event_name: sess?.event_name ?? null,
          requested_status: status,
        },
      });
    }
    const result = timingTransaction(() => {
      let run = getRun(event_type);
      const changed =
        run &&
        !sess.armed &&
        (run.bound?.event_name !== sess.event_name ||
          Number(run.bound?.team?.teamId ?? run.bound?.team?.id ?? run.bound?.team?.num) !==
            Number(sess.team?.teamId ?? sess.team?.id ?? sess.team?.num));
      if (changed) run = null;
      if (!run) {
        const runId = crypto.randomUUID();
        db.prepare(
          "UPDATE wireless_session SET run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL WHERE event_type = ?",
        ).run(runId, event_type);
        resetEngineRun(event_type, { team: sess.team, event_name: sess.event_name }, runId);
        run = getRun(event_type);
      }
      const name = run.recordName ?? (changed ? null : sess.saved_record_name);
      const rowid = run.recordRowid ?? (changed ? null : sess.saved_record_rowid);
      const before = name && rowid != null ? getRecordRow(name, rowid) : null;
      let saved;
      if (before) {
        const year = recordYearFromName(name);
        if (year !== currentRecordYear() || !isTeamActive(db, year, before.num)) {
          const error = new Error("현재 연도의 활성 팀 기록만 판정할 수 있습니다.");
          error.status = 409;
          throw error;
        }
        db.prepare("UPDATE record SET status = ? WHERE name = ? AND legacy_rowid = ?").run(
          status,
          name,
          rowid,
        );
        saved = { name, record: getRecordRow(name, rowid) };
        broadcastEvent("records", {
          type: "update",
          name,
          field: "status",
          recordFiles: getRecordFiles(),
          record: saved.record,
          event_type,
          run_id: run.runId,
        });
      } else {
        saved = engineSaveRecord(event_type, run.bound, null, null, { req }, status);
        if (!saved) throw new Error("판정 저장에 필요한 선택 정보가 없습니다.");
      }
      run.recordName = saved.name;
      run.recordRowid = saved.record.rowid;
      run.closed = true;
      db.prepare(
        "UPDATE wireless_session SET saved_record_name = ?, saved_record_rowid = ? WHERE event_type = ?",
      ).run(saved.name, saved.record.rowid, event_type);
      logger.log(
        req,
        "wireless.status",
        { event_type, status, run_id: run.runId, before, after: saved.record },
        saved.name,
      );
      return { ...saved, session: getSession(event_type) };
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.status",
        { error: result.internalError || result.error, event_type, status },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }
    broadcastEvent("wireless:session", result.result.session);
    res.json(result.result);
  });

  // GET /api/wireless/state - 신선 로드용 종합 스냅샷.
  app.get("/api/wireless/state", (req, res) => {
    const result = dbRun(() => ({
      light: getLightState(),
      mapping: getMapping(),
      telemetry: getLiveTelemetry(),
      bridge: getBridgeState(),
      sessions: getSessions(),
      qualityFaults: getLiveQualityFaults(),
      lastEventId: getLastEventId(),
    }));
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // GET /api/wireless/events?since=&limit= - 늦게 합류한 클라이언트의 이벤트 백필.
  app.get("/api/wireless/events", (req, res) => {
    const since = Number.parseInt(req.query.since, 10);
    const sinceId = Number.isFinite(since) ? since : 0;
    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 200;
    limit = Math.max(1, Math.min(limit, 1000));
    const result = dbRun(() =>
      db
        .prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id ASC LIMIT ?")
        .all(sinceId, limit),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });
}
