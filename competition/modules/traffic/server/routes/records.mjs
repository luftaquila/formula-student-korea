import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";
import { RESULT_STATUSES } from "../../../../../shared/common/constants.js";
import { isTeamActive } from "../../../../lib/team-status.mjs";

export function registerRecordsRoutes({
  app,
  dbRun,
  getRecordFiles,
  getRecordVisibility,
  getYearRecordGroups,
  validateRecordName,
  logger,
  runRecordPreflight,
  tableExists,
  db,
  broadcastEvent,
  getRecordRows,
  rejectMutation,
  validateRecordData,
  insertRecordRow,
  recordYearFromName,
  currentRecordYear,
  isRecordBoundToActiveTeam,
  timingTransaction,
  getRun,
  getRecordRow,
  recordFileExists,
  getSession,
  reservedSql,
}) {
  /* ============================================
   API 라우트: /api/records
   ============================================ */

  // GET /api/records - 모든 기록 테이블 목록 조회
  app.get("/api/records", (req, res) => {
    const result = dbRun(() => {
      return getRecordFiles();
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/records/visibility - 기록 파일별 성적 반영 상태 조회
  app.get("/api/records/visibility", (req, res) => {
    res.json(getRecordVisibility());
  });

  // GET /api/records/year/:year - score 집계용 연도별 기록 일괄 조회
  app.get("/api/records/year/:year", (req, res) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2099)
      return res.status(400).send("올바르지 않은 연도입니다.");

    const result = dbRun(() => getYearRecordGroups(year));

    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // PUT /api/records/:name/visibility - 기록 파일 성적 반영 토글
  app.put("/api/records/:name/visibility", (req, res) => {
    const validation = validateRecordName(req.params.name);
    if (!validation.valid) {
      logger.warn(req, "record.visibility", { error: validation.error }, req.params.name);
      return res.status(400).send(validation.error);
    }

    const name = validation.value;
    const preflight = runRecordPreflight(req, res, {
      action: "record.visibility",
      operation: "visibility_toggle",
      target: name,
      lookup: () =>
        tableExists(name)
          ? { value: true }
          : {
              rejection: {
                status: 404,
                message: "기록을 찾을 수 없습니다.",
                context: { reason_code: "record_not_found", record_name: name },
              },
            },
    });
    if (!preflight.ok) return;

    const result = dbRun(() => {
      const row = db.prepare("SELECT visible FROM record_visibility WHERE name = ?").get(name);
      const newVisible = row ? (row.visible ? 0 : 1) : 0;
      db.prepare(
        "INSERT INTO record_visibility (name, visible) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET visible = excluded.visible",
      ).run(name, newVisible);
      return { name, visible: newVisible };
    });

    if (!result.success) {
      logger.warn(req, "record.visibility", { error: result.internalError || result.error }, name);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "record.visibility", { visible: !!result.result.visible }, name);

    broadcastEvent("record-visibility", result.result);

    res.json(result.result);
  });

  // GET /api/records/:name - 특정 기록 조회
  app.get("/api/records/:name", (req, res) => {
    const validation = validateRecordName(req.params.name);
    if (!validation.valid) {
      return res.status(400).send(validation.error);
    }

    const name = validation.value;

    if (!tableExists(name)) {
      return res.status(404).send("기록을 찾을 수 없습니다.");
    }

    const result = dbRun(() => getRecordRows(name));

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // POST /api/records - 새 기록 추가
  app.post("/api/records", (req, res) => {
    const nameValidation = validateRecordName(req.body.name);
    if (!nameValidation.valid) {
      return rejectMutation(req, res, {
        action: "record.create",
        status: 400,
        message: nameValidation.error,
        target: "record",
        operation: "create",
        context: { requested_name: req.body?.name ?? null },
      });
    }

    const dataValidation = validateRecordData(req.body.data);
    if (!dataValidation.valid) {
      return rejectMutation(req, res, {
        action: "record.create",
        status: 400,
        message: dataValidation.error,
        target: nameValidation.value,
        operation: "create",
        context: {
          entry_num: req.body?.data?.entry?.num ?? null,
          result: req.body?.data?.result ?? null,
          status: req.body?.data?.status ?? null,
        },
      });
    }

    const name = `FSK ${currentCompetitionYear()} ${nameValidation.value}`;
    const data = req.body.data;

    const result = dbRun(() => {
      return db.transaction(() => insertRecordRow(name, data))();
    });

    if (!result.success) {
      logger.warn(
        req,
        "record.create",
        { error: result.internalError || result.error, entry_num: data.entry.num },
        name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "record.create",
      {
        entry_num: data.entry.num,
        type: data.type,
        result: data.result ?? null,
        status: data.status ?? null,
      },
      name,
    );

    // SSE 브로드캐스트
    broadcastEvent("records", {
      type: "add",
      name,
      recordFiles: getRecordFiles(),
      record: result.result,
    });

    // 생성된 테이블명 + 행(rowid 포함) 반환 — 내구처럼 같은 기록에 이어붙이는 클라가 PATCH에 쓸
    // 테이블명/rowid를 받는다. 기존 호출부는 본문을 무시하므로 하위호환.
    res.status(201).json({ name, record: result.result });
  });

  // PATCH /api/records/:name/:rowid - 기록 필드 업데이트
  app.patch("/api/records/:name/:rowid", (req, res) => {
    const validation = validateRecordName(req.params.name);
    if (!validation.valid) {
      return rejectMutation(req, res, {
        action: "record.update",
        status: 400,
        message: validation.error,
        target: "record",
        operation: "update",
        context: { requested_name: req.params.name ?? null, rowid: req.params.rowid ?? null },
      });
    }

    const name = validation.value;
    const recordYear = recordYearFromName(name);
    if (recordYear == null) {
      logger.warn(req, "record.update", { error: "unparseable competition year" }, name);
      return res.status(400).send("기록 이름에서 대회 연도를 확인할 수 없습니다.");
    }
    if (recordYear !== currentRecordYear()) {
      logger.warn(
        req,
        "record.update",
        { error: "historical record is read-only", recordYear },
        name,
      );
      return res.status(409).send("현재 연도의 기록만 수정할 수 있습니다.");
    }

    const rowid = parseInt(req.params.rowid, 10);

    if (isNaN(rowid)) {
      return rejectMutation(req, res, {
        action: "record.update",
        status: 400,
        message: "올바르지 않은 rowid입니다.",
        target: name,
        operation: "update",
        context: { rowid: req.params.rowid ?? null },
      });
    }
    const { field, value } = req.body;
    if (!["status", "scoreboard", "detail", "cones", "oc", "result"].includes(field)) {
      return rejectMutation(req, res, {
        action: "record.update",
        status: 400,
        message: "올바르지 않은 필드입니다.",
        target: name,
        operation: "update",
        context: { rowid, field: field ?? null },
      });
    }
    if (field === "status" && value !== null && !RESULT_STATUSES.includes(value)) {
      return rejectMutation(req, res, {
        action: "record.update",
        status: 400,
        message: "판정은 DNS, DNF, DSQ 또는 비움이어야 합니다.",
        target: name,
        operation: "update",
        context: { rowid, field, requested_status: value ?? null },
      });
    }
    if (field === "result" && value !== null && (!Number.isInteger(value) || value <= 0)) {
      return rejectMutation(req, res, {
        action: "record.update",
        status: 400,
        message: "측정시간은 양의 정수(ms) 또는 비움이어야 합니다.",
        target: name,
        operation: "update",
        context: { rowid, field, requested_result: value ?? null },
      });
    }

    const preflight = runRecordPreflight(req, res, {
      action: "record.update",
      operation: "update",
      target: name,
      lookup: () => {
        if (!tableExists(name)) {
          return {
            rejection: {
              status: 404,
              message: "기록을 찾을 수 없습니다.",
              context: { reason_code: "record_not_found", record_name: name, rowid, field },
            },
          };
        }
        const hasTeamId = db
          .prepare("PRAGMA table_info(record)")
          .all()
          .some((column) => column.name === "team_id");
        const targetRecord = db
          .prepare(
            `
        SELECT num, result, status${hasTeamId ? ", team_id" : ""}
        FROM record WHERE name = ? AND legacy_rowid = ?
      `,
          )
          .get(name, rowid);
        if (!targetRecord) {
          return {
            rejection: {
              status: 404,
              message: "기록을 찾을 수 없습니다.",
              context: { reason_code: "record_row_not_found", record_name: name, rowid, field },
            },
          };
        }
        if (!isTeamActive(db, recordYear, targetRecord.num)) {
          return {
            rejection: {
              status: 409,
              message: "비활성화된 엔트리의 기록은 수정할 수 없습니다.",
              context: {
                reason_code: "inactive_or_missing_team",
                record_name: name,
                rowid,
                field,
                year: recordYear,
                team_num: targetRecord.num,
              },
            },
          };
        }
        if (
          field === "status" &&
          targetRecord.status === "DSQ" &&
          value !== "DSQ" &&
          !isRecordBoundToActiveTeam(recordYear, targetRecord)
        ) {
          return {
            rejection: {
              status: 409,
              message: "팀 연결이 없는 레거시 DSQ 기록은 판정을 변경할 수 없습니다.",
              context: {
                reason_code: "missing_active_canonical_team_binding",
                record_name: name,
                rowid,
                field,
                year: recordYear,
                team_num: targetRecord.num,
                team_id: targetRecord.team_id ?? null,
              },
            },
          };
        }
        return { value: targetRecord };
      },
    });
    if (!preflight.ok) return;

    const execute = field === "status" ? timingTransaction : dbRun;
    const result = execute(() => {
      const row = db
        .prepare(
          `
      SELECT num, result, status, scoreboard, detail, cones, oc
      FROM record WHERE name = ? AND legacy_rowid = ?
    `,
        )
        .get(name, rowid);
      if (!row) {
        const err = new Error("기록을 찾을 수 없습니다.");
        err.status = 404;
        throw err;
      }

      if (field === "status") {
        if (value === null && row.result == null) {
          const err = new Error(
            "측정시간이 없는 판정 기록은 정상으로 복원할 수 없습니다. 판정 취소를 사용하세요.",
          );
          err.status = 400;
          throw err;
        }
        db.prepare("UPDATE record SET status = ? WHERE name = ? AND legacy_rowid = ?").run(
          value,
          name,
          rowid,
        );
        const sessions = db
          .prepare(
            `SELECT event_type, run_id FROM wireless_session
        WHERE saved_record_name = ? AND saved_record_rowid = ?`,
          )
          .all(name, rowid);
        for (const session of sessions) {
          const run = getRun(session.event_type);
          if (run?.runId === session.run_id) run.closed = true;
        }
        return { num: row.num, result: row.result, status: value, scoreboard: row.scoreboard };
      } else if (field === "scoreboard") {
        const newStatus = row.scoreboard ? 0 : 1;
        db.prepare("UPDATE record SET scoreboard = ? WHERE name = ? AND legacy_rowid = ?").run(
          newStatus,
          name,
          rowid,
        );
        return { num: row.num, result: row.result, status: row.status, scoreboard: newStatus };
      } else if (field === "detail") {
        db.prepare("UPDATE record SET detail = ? WHERE name = ? AND legacy_rowid = ?").run(
          value ?? null,
          name,
          rowid,
        );
        return {
          num: row.num,
          result: row.result,
          status: row.status,
          scoreboard: row.scoreboard,
          detail: value ?? null,
        };
      } else if (field === "result") {
        if (value === null && row.status === null) {
          const err = new Error("정상 기록의 측정시간은 비울 수 없습니다.");
          err.status = 400;
          throw err;
        }
        db.prepare("UPDATE record SET result = ? WHERE name = ? AND legacy_rowid = ?").run(
          value,
          name,
          rowid,
        );
        return { num: row.num, result: value, status: row.status, scoreboard: row.scoreboard };
      } else if (field === "cones") {
        const numValue = Math.max(0, parseInt(value, 10) || 0);
        db.prepare("UPDATE record SET cones = ? WHERE name = ? AND legacy_rowid = ?").run(
          numValue,
          name,
          rowid,
        );
        return { num: row.num, cones: numValue };
      } else if (field === "oc") {
        const numValue = Math.max(0, parseInt(value, 10) || 0);
        db.prepare("UPDATE record SET oc = ? WHERE name = ? AND legacy_rowid = ?").run(
          numValue,
          name,
          rowid,
        );
        return { num: row.num, oc: numValue };
      }
    });

    if (!result.success) {
      logger.warn(
        req,
        "record.update",
        {
          error: result.internalError || result.error,
          rowid,
          field,
          requested_value: value ?? null,
        },
        name,
      );
      return res.status(result.status).send(result.error);
    }

    const updateAudit = { entry_num: result.result.num, rowid, field, ...result.result };
    if (field === "status") {
      updateAudit.before = { result: preflight.value.result, status: preflight.value.status };
      updateAudit.after = { result: result.result.result, status: result.result.status };
    }
    logger.log(req, "record.update", updateAudit, name);

    // SSE 브로드캐스트 (업데이트된 전체 행 포함)
    try {
      const updatedRow = getRecordRow(name, rowid);
      broadcastEvent("records", {
        type: "update",
        name,
        field,
        recordFiles: getRecordFiles(),
        record: updatedRow,
      });
    } catch (e) {
      logger.warn(req, "record.update", { error: e.message, phase: "sse_broadcast" }, name);
    }

    res.json(result.result);
  });

  // DELETE /api/records/:name/:rowid - 시간 없는 판정 전용 행 취소.
  // 측정 원시값이 있는 행은 상태로 보존해야 하므로 이 경로에서 삭제하지 않는다.
  app.delete("/api/records/:name/:rowid", (req, res) => {
    const validation = validateRecordName(req.params.name);
    if (!validation.valid) {
      return rejectMutation(req, res, {
        action: "record.row_delete",
        status: 400,
        message: validation.error,
        target: "record",
        operation: "delete_status_only_row",
        context: { requested_name: req.params.name ?? null, rowid: req.params.rowid ?? null },
      });
    }
    const name = validation.value;
    const recordYear = recordYearFromName(name);
    if (recordYear == null) {
      return rejectMutation(req, res, {
        action: "record.row_delete",
        status: 400,
        message: "기록 이름에서 대회 연도를 확인할 수 없습니다.",
        target: name,
        operation: "delete_status_only_row",
      });
    }
    if (recordYear !== currentRecordYear()) {
      return rejectMutation(req, res, {
        action: "record.row_delete",
        status: 409,
        message: "현재 연도의 기록만 수정할 수 있습니다.",
        target: name,
        operation: "delete_status_only_row",
        context: { record_year: recordYear },
      });
    }
    const rowid = Number.parseInt(req.params.rowid, 10);
    if (!Number.isInteger(rowid)) {
      return rejectMutation(req, res, {
        action: "record.row_delete",
        status: 400,
        message: "올바르지 않은 rowid입니다.",
        target: name,
        operation: "delete_status_only_row",
        context: { rowid: req.params.rowid ?? null },
      });
    }

    const hasTeamId = db
      .prepare("PRAGMA table_info(record)")
      .all()
      .some((column) => column.name === "team_id");
    const preflight = runRecordPreflight(req, res, {
      action: "record.row_delete",
      operation: "delete_status_only_row",
      target: name,
      lookup: () => {
        const row = db
          .prepare(
            `
        SELECT num, result, status${hasTeamId ? ", team_id" : ""}
        FROM record WHERE name = ? AND legacy_rowid = ?
      `,
          )
          .get(name, rowid);
        if (!row)
          return {
            rejection: { status: 404, message: "기록을 찾을 수 없습니다.", context: { rowid } },
          };
        if (!isTeamActive(db, recordYear, row.num)) {
          return {
            rejection: {
              status: 409,
              message: "비활성화된 엔트리의 기록은 수정할 수 없습니다.",
              context: { year: recordYear, team_num: row.num, rowid },
            },
          };
        }
        if (row.result != null) {
          return {
            rejection: {
              status: 409,
              message: "측정시간이 있는 기록은 삭제할 수 없습니다. 판정을 변경하세요.",
              context: { rowid, result: row.result, status: row.status },
            },
          };
        }
        return { value: row };
      },
    });
    if (!preflight.ok) return;

    const result = dbRun(() =>
      db.transaction(() => {
        const before = getRecordRow(name, rowid);
        if (!before) {
          const error = new Error("기록을 찾을 수 없습니다.");
          error.status = 404;
          throw error;
        }
        const affectedSessions = db
          .prepare(
            `
      SELECT event_type, run_id FROM wireless_session
      WHERE saved_record_name = ? AND saved_record_rowid = ?
    `,
          )
          .all(name, rowid);
        const deleted = db
          .prepare("DELETE FROM record WHERE name = ? AND legacy_rowid = ?")
          .run(name, rowid).changes;
        if (deleted !== 1) throw new Error("기록 삭제 대상이 변경되었습니다.");
        db.prepare(
          `
      UPDATE wireless_session
      SET saved_record_name = NULL, saved_record_rowid = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE saved_record_name = ? AND saved_record_rowid = ?
    `,
        ).run(name, rowid);
        if (!recordFileExists(name))
          db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
        return { before, affectedSessions };
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "record.row_delete",
        { error: result.internalError || result.error, rowid },
        name,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "record.row_delete", { rowid, before: result.result.before }, name);
    for (const { event_type: eventType, run_id: runId } of result.result.affectedSessions) {
      broadcastEvent("wireless:session", getSession(eventType));
    }
    broadcastEvent("records", {
      type: "remove",
      name,
      rowid,
      recordFiles: getRecordFiles(),
      record: result.result.before,
    });
    res.json({ name, rowid, deleted: true });
  });

  // DELETE /api/records/:name - 기록 테이블 삭제
  app.delete("/api/records/:name", (req, res) => {
    const validation = validateRecordName(req.params.name);
    if (!validation.valid) {
      return res.status(400).send(validation.error);
    }

    const name = validation.value;
    const preflight = runRecordPreflight(req, res, {
      action: "record.delete",
      operation: "delete",
      target: name,
      lookup: () =>
        tableExists(name)
          ? { value: true }
          : {
              rejection: {
                status: 404,
                message: "기록을 찾을 수 없습니다.",
                context: { reason_code: "record_not_found", record_name: name },
              },
            },
    });
    if (!preflight.ok) return;

    const result = dbRun(() =>
      db.transaction(() => {
        const deleted = db.prepare("DELETE FROM record WHERE name = ?").run(name).changes;
        const legacy = db
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? AND name NOT IN (${reservedSql})`,
          )
          .get(name);
        if (legacy) db.exec(`DROP TABLE IF EXISTS '${name}'`);
        db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
        return deleted;
      })(),
    );

    if (!result.success) {
      logger.warn(req, "record.delete", { error: result.internalError || result.error }, name);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "record.delete", { deleted: result.result }, name);

    // SSE 브로드캐스트
    broadcastEvent("records", { type: "delete", name, recordFiles: getRecordFiles() });

    res.status(200).send();
  });
}
