import { validateYear } from "../../../../../shared/common/validation.mjs";
import path from "path";

export function registerAdminSessionsRoutes({
  app,
  db,
  normalizeTimestamp,
  dbRun,
  logger,
  scheduleSessionNotifications,
  auditedLookup,
  submissionUploadDir,
  rmDir,
  logCleanupFailures,
  UPLOADS_DIR,
}) {
  /* ============================================
   Chief/Admin API
   ============================================ */

  // GET /api/admin/sessions - 전체 세션 목록
  app.get("/api/admin/sessions", (req, res) => {
    const year = req.query.year ? Number(req.query.year) : null;
    const sessions = year
      ? db.prepare("SELECT * FROM session WHERE year = ? ORDER BY created_at DESC").all(year)
      : db.prepare("SELECT * FROM session ORDER BY created_at DESC").all();
    res.json(sessions);
  });

  // POST /api/admin/sessions - 세션 생성
  app.post("/api/admin/sessions", (req, res) => {
    const { name, notice, start_at, end_at, max_file_size, allowed_extensions, year, teams } =
      req.body;
    const rawLateEnd = req.body.late_end_at || "";
    if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
    if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
    const nStart = normalizeTimestamp(start_at);
    const nEnd = normalizeTimestamp(end_at);
    if (!nStart || !nEnd) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
    const nLateEnd = rawLateEnd ? normalizeTimestamp(rawLateEnd) : "";
    if (rawLateEnd && !nLateEnd)
      return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
    if (nEnd <= nStart) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
    if (nLateEnd && nLateEnd < nEnd)
      return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
    const yearCheck = validateYear(year);
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    const numYear = yearCheck.value;
    if (!Array.isArray(teams) || teams.length === 0)
      return res.status(400).send("대상 팀을 선택하세요.");

    const maxSize = max_file_size ? Number(max_file_size) : 52428800;
    if (!Number.isFinite(maxSize) || maxSize <= 0 || maxSize > 524288000)
      return res.status(400).send("올바르지 않은 파일 크기 제한입니다 (최대 500MB).");
    const exts = allowed_extensions || "";

    for (const t of teams) {
      if (!Number.isInteger(t) || t < 1)
        return res.status(400).send("올바르지 않은 팀 번호가 포함되어 있습니다.");
    }

    const txResult = dbRun(() => {
      const tx = db.transaction(() => {
        const result = db
          .prepare(
            "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            name.trim(),
            notice || "",
            nStart,
            nEnd,
            nLateEnd,
            maxSize,
            exts,
            req.user.email,
            numYear,
          );
        const sessionId = result.lastInsertRowid;

        const teamStmt = db.prepare(
          "INSERT INTO session_team (session_id, team_num) VALUES (?, ?)",
        );
        for (const t of teams) teamStmt.run(sessionId, t);

        return { id: sessionId };
      });
      return tx();
    });

    if (!txResult.success) {
      logger.warn(
        req,
        "session.create",
        { error: txResult.internalError || txResult.error },
        name.trim(),
      );
      return res.status(txResult.status).send(txResult.error);
    }
    logger.log(
      req,
      "session.create",
      {
        year: numYear,
        start_at: nStart,
        end_at: nEnd,
        late_end_at: nLateEnd || undefined,
        max_file_size: maxSize,
        allowed_extensions: exts,
        teams: teams.length,
      },
      name.trim(),
    );
    res.status(201).json(txResult.result);

    // 예약 알림 등록 (세션 시작 시, 마감 3시간 전, 마감 1시간 전)
    try {
      scheduleSessionNotifications(txResult.result.id, nStart, nEnd);
    } catch (e) {
      logger.warn(req, "schedule.register", { error: e.message, session_id: txResult.result.id });
    }
  });

  // PUT /api/admin/sessions/:id - 세션 수정
  app.put("/api/admin/sessions/:id", (req, res) => {
    const id = Number(req.params.id);
    const { name, notice, start_at, end_at, max_file_size, allowed_extensions, teams } = req.body;
    const rawLateEnd = req.body.late_end_at || "";

    const preflight = auditedLookup(req, res, {
      action: "session.update",
      target: `session:${id}`,
      phase: "session_preflight",
      message: "세션을 확인할 수 없습니다.",
      lookup: () => {
        const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
        const oldTeams = session
          ? db
              .prepare("SELECT team_num FROM session_team WHERE session_id = ? ORDER BY team_num")
              .all(id)
              .map((row) => row.team_num)
          : [];
        return { session, oldTeams };
      },
    });
    if (!preflight.ok) return;
    const { session, oldTeams } = preflight.value;
    if (!session) {
      logger.warn(
        req,
        "session.update",
        {
          error: "session_not_found",
          reason: "session_not_found",
          phase: "session_preflight",
          session_id: id,
        },
        `session:${id}`,
      );
      return res.status(404).send("세션을 찾을 수 없습니다.");
    }

    if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
    if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
    const nStart = normalizeTimestamp(start_at);
    const nEnd = normalizeTimestamp(end_at);
    if (!nStart || !nEnd) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
    const nLateEnd = rawLateEnd ? normalizeTimestamp(rawLateEnd) : "";
    if (rawLateEnd && !nLateEnd)
      return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
    if (nEnd <= nStart) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
    if (nLateEnd && nLateEnd < nEnd)
      return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
    if (!Array.isArray(teams) || teams.length === 0)
      return res.status(400).send("대상 팀을 선택하세요.");

    const maxSize = max_file_size ? Number(max_file_size) : 52428800;
    if (!Number.isFinite(maxSize) || maxSize <= 0 || maxSize > 524288000)
      return res.status(400).send("올바르지 않은 파일 크기 제한입니다 (최대 500MB).");
    const exts = allowed_extensions || "";

    for (const t of teams) {
      if (!Number.isInteger(t) || t < 1)
        return res.status(400).send("올바르지 않은 팀 번호가 포함되어 있습니다.");
    }

    const removedSubmissions = [];
    const txResult = dbRun(() => {
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE session SET name = ?, notice = ?, start_at = ?, end_at = ?, late_end_at = ?, max_file_size = ?, allowed_extensions = ? WHERE id = ?",
        ).run(name.trim(), notice || "", nStart, nEnd, nLateEnd, maxSize, exts, id);

        const newTeamsSet = new Set(teams);

        // 제거되는 팀의 제출물 정리
        for (const oldTeam of oldTeams) {
          if (!newTeamsSet.has(oldTeam)) {
            const subs = db
              .prepare(
                "SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? AND team_num = ?",
              )
              .all(id, oldTeam);
            if (subs.length)
              db.prepare("DELETE FROM submission WHERE session_id = ? AND team_num = ?").run(
                id,
                oldTeam,
              );
            if (subs.length) removedSubmissions.push(...subs);
          }
        }

        db.prepare("DELETE FROM session_team WHERE session_id = ?").run(id);
        const teamStmt = db.prepare(
          "INSERT INTO session_team (session_id, team_num) VALUES (?, ?)",
        );
        for (const t of teams) teamStmt.run(id, t);
      });
      return tx();
    });

    if (!txResult.success) {
      logger.warn(
        req,
        "session.update",
        { error: txResult.internalError || txResult.error },
        name.trim(),
      );
      return res.status(txResult.status).send(txResult.error);
    }

    // 트랜잭션 성공 후 디스크 파일 정리
    const cleanup = removedSubmissions.map((submission) => {
      const directory = submissionUploadDir(submission);
      return {
        submission_id: submission.id,
        team_num: submission.team_num,
        storage_dir: submission.storage_dir,
        directory,
        ...rmDir(directory, { logFailure: false }),
      };
    });
    const auditDetail = {
      session_id: id,
      year: session.year,
      before_teams: oldTeams,
      after_teams: [...teams].sort((a, b) => a - b),
      deleted_submissions: removedSubmissions.map((submission) => ({
        id: submission.id,
        team_num: submission.team_num,
        storage_dir: submission.storage_dir,
      })),
      file_cleanup: cleanup,
    };
    logger.log(req, "session.update", auditDetail, name.trim());
    logCleanupFailures(
      req,
      "session.update",
      name.trim(),
      {
        session_id: id,
        year: session.year,
        before_teams: oldTeams,
        after_teams: auditDetail.after_teams,
      },
      cleanup,
    );
    res.status(200).send();

    // 예약 알림 재등록 (날짜 변경 반영)
    try {
      scheduleSessionNotifications(id, nStart, nEnd);
    } catch (e) {
      logger.warn(req, "schedule.register", { error: e.message, session_id: id });
    }
  });

  // DELETE /api/admin/sessions/:id - 세션 삭제
  app.delete("/api/admin/sessions/:id", (req, res) => {
    const id = Number(req.params.id);
    const preflight = auditedLookup(req, res, {
      action: "session.delete",
      target: `session:${id}`,
      phase: "session_preflight",
      message: "세션을 확인할 수 없습니다.",
      lookup: () => {
        const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
        const submissions = session
          ? db
              .prepare(
                "SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? ORDER BY id",
              )
              .all(id)
          : [];
        return { session, submissions };
      },
    });
    if (!preflight.ok) return;
    const { session, submissions } = preflight.value;
    if (!session) {
      logger.warn(
        req,
        "session.delete",
        {
          error: "session_not_found",
          reason: "session_not_found",
          phase: "session_preflight",
          session_id: id,
        },
        `session:${id}`,
      );
      return res.status(404).send("세션을 찾을 수 없습니다.");
    }

    const txResult = dbRun(() => {
      db.prepare("DELETE FROM session WHERE id = ?").run(id);
    });

    if (!txResult.success) {
      logger.warn(
        req,
        "session.delete",
        { error: txResult.internalError || txResult.error },
        session.name,
      );
      return res.status(txResult.status).send(txResult.error);
    }

    const directory = path.join(UPLOADS_DIR, String(id));
    const cleanup = [{ directory, ...rmDir(directory, { logFailure: false }) }];
    const auditDetail = {
      id,
      year: session.year,
      deleted_submissions: submissions.map((submission) => ({
        id: submission.id,
        team_num: submission.team_num,
        storage_dir: submission.storage_dir,
      })),
      file_cleanup: cleanup,
    };
    logger.log(req, "session.delete", auditDetail, session.name);
    logCleanupFailures(
      req,
      "session.delete",
      session.name,
      { session_id: id, year: session.year },
      cleanup,
    );

    res.status(200).send();
  });

  // GET /api/admin/sessions/:id/status - 팀별 제출 현황
  app.get("/api/admin/sessions/:id/status", (req, res) => {
    const id = Number(req.params.id);
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
    if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

    const teams = db
      .prepare("SELECT team_num FROM session_team WHERE session_id = ? ORDER BY team_num")
      .all(id);

    const submissions = db
      .prepare(
        `
    SELECT id, team_num, submitted_at, total_size, is_late, submitted_by, attempt_no, rn
    FROM (
      SELECT s.id, s.team_num, s.submitted_at, s.total_size, s.is_late, s.submitted_by, s.attempt_no,
             ROW_NUMBER() OVER (PARTITION BY s.team_num ORDER BY s.id DESC) AS rn
      FROM submission s
      WHERE s.session_id = ?
    )
    WHERE rn <= 2
    ORDER BY team_num, rn
  `,
      )
      .all(id);
    const submissionsByTeam = new Map();
    for (const sub of submissions) {
      const list = submissionsByTeam.get(sub.team_num) || [];
      list.push(sub);
      submissionsByTeam.set(sub.team_num, list);
    }

    const filesBySubmission = new Map();
    if (submissions.length > 0) {
      const placeholders = submissions.map(() => "?").join(",");
      const files = db
        .prepare(
          `
      SELECT submission_id, id, original_name, size, mime_type
      FROM submission_file
      WHERE submission_id IN (${placeholders})
      ORDER BY id
    `,
        )
        .all(...submissions.map((s) => s.id));
      for (const file of files) {
        const list = filesBySubmission.get(file.submission_id) || [];
        list.push({
          id: file.id,
          original_name: file.original_name,
          size: file.size,
          mime_type: file.mime_type,
        });
        filesBySubmission.set(file.submission_id, list);
      }
    }

    const status = teams.map((t) => {
      const subs = submissionsByTeam.get(t.team_num) || [];
      const sub = subs[0] ? (({ team_num, rn, ...rest }) => rest)(subs[0]) : null;
      const files = sub ? filesBySubmission.get(sub.id) || [] : [];
      const prevSub = subs[1] ? (({ team_num, rn, ...rest }) => rest)(subs[1]) : null;
      const prevFiles = prevSub ? filesBySubmission.get(prevSub.id) || [] : [];
      // 백필 누락 등으로 attempt_no가 0이면 최소 1로 보정 (sub이 존재하니 최소 1회 제출은 있음)
      const submissionCount = sub ? sub.attempt_no || 1 : 0;
      return {
        team_num: t.team_num,
        submission: sub,
        files,
        prevSubmission: prevSub,
        prevFiles,
        submissionCount,
      };
    });

    res.json({ session, status });
  });
}
