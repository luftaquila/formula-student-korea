import Busboy from "busboy";
import crypto from "crypto";
import path from "path";
import fs from "fs";

export function registerSubmissionsRoutes({
  app,
  auditedLookup,
  db,
  logger,
  options,
  now,
  readTMP_DIR,
  rmDir,
  safeExt,
  inlineDisposition,
  createTextCharsetDetector,
  dbRun,
  submissionUploadDir,
}) {
  // POST /api/sessions/:id/submit - 파일 업로드
  app.post("/api/sessions/:id/submit", (req, res) => {
    const sessionId = Number(req.params.id);
    const preflight = auditedLookup(req, res, {
      action: "submission.create",
      target: `session:${sessionId}`,
      phase: "submission_preflight",
      message: "제출 대상을 확인할 수 없습니다.",
      lookup: () => {
        const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
        if (!session) return { session: null, team: null, isTarget: false };
        const team = db
          .prepare("SELECT * FROM student_team WHERE email = ? AND year = ?")
          .get(req.user.email, session.year);
        const isTarget = team
          ? !!db
              .prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?")
              .get(session.id, team.team_num)
          : false;
        return { session, team, isTarget };
      },
    });
    if (!preflight.ok) return;
    const { session, team, isTarget } = preflight.value;
    if (!session) {
      logger.warn(
        req,
        "submission.create",
        {
          error: "session_not_found",
          reason: "session_not_found",
          phase: "submission_preflight",
          session_id: sessionId,
        },
        `session:${sessionId}`,
      );
      return res.status(404).send("세션을 찾을 수 없습니다.");
    }

    // cross-year IDOR 방지: 팀 번호는 연도별로 재할당되므로 세션 연도의 팀 매핑으로 해석한다.
    // 세션 연도에 매핑이 없으면(다른 연도 매핑만 있어도) 이 세션 대상이 아니다 — 이렇게 하면
    // 학생이 최신 연도 매핑을 가져도 과거 세션에 정상 제출할 수 있고, 타 연도 팀의 세션 접근은 막힌다.
    if (!team) {
      logger.warn(
        req,
        "submission.create",
        { error: "no_team_for_year", session_id: session.id, year: session.year },
        session.name,
      );
      return res.status(403).send("대상 팀이 아닙니다.");
    }
    if (!isTarget) {
      logger.warn(
        req,
        "submission.create",
        { error: "not_target", session_id: session.id },
        session.name,
      );
      return res.status(403).send("대상 팀이 아닙니다.");
    }
    let canonicalTeam;
    try {
      const storedTeamId = Number(team.team_id);
      canonicalTeam =
        Number.isInteger(storedTeamId) && storedTeamId > 0
          ? options.teamStore?.getById?.(storedTeamId)
          : null;
      canonicalTeam ||= options.teamStore?.getByNumber?.(session.year, team.team_num, {
        includeInactive: true,
      });
    } catch (error) {
      logger.warn(
        req,
        "submission.create",
        {
          error: error?.message || String(error),
          phase: "canonical_team_lookup",
          session_id: session.id,
          year: session.year,
          team_num: team.team_num,
        },
        session.name,
      );
      return res.status(500).send("팀 기준 정보를 확인할 수 없습니다.");
    }
    const canonicalTeamId = Number(canonicalTeam?.id);
    const canonicalTeamYear = Number(canonicalTeam?.year ?? session.year);
    const canonicalTeamNum = Number(canonicalTeam?.number ?? canonicalTeam?.num ?? team.team_num);
    const canonicalTeamActive = canonicalTeam?.active == null ? null : !!canonicalTeam.active;
    if (
      !Number.isInteger(canonicalTeamId) ||
      canonicalTeamId < 1 ||
      canonicalTeamYear !== session.year ||
      canonicalTeamNum !== team.team_num
    ) {
      logger.warn(
        req,
        "submission.create",
        {
          error: "missing_canonical_team_id",
          session_id: session.id,
          year: session.year,
          team_num: team.team_num,
        },
        session.name,
      );
      return res.status(409).send("팀 기준 정보를 찾을 수 없습니다.");
    }

    const startTime = now();
    const effectiveLateEnd = session.late_end_at || session.end_at;
    if (startTime < session.start_at) {
      logger.warn(
        req,
        "submission.create",
        {
          error: "submission_not_open",
          reason: "submission_not_open",
          phase: "submission_window",
          session_id: session.id,
          year: session.year,
          team_num: team.team_num,
          started_at: startTime,
          opens_at: session.start_at,
        },
        session.name,
      );
      return res.status(400).send("제출 기간이 아닙니다.");
    }
    if (startTime > effectiveLateEnd) {
      logger.warn(
        req,
        "submission.create",
        {
          error: "submission_closed",
          reason: "submission_closed",
          phase: "submission_window",
          session_id: session.id,
          year: session.year,
          team_num: team.team_num,
          started_at: startTime,
          closes_at: effectiveLateEnd,
        },
        session.name,
      );
      return res.status(400).send("제출 기간이 종료되었습니다.");
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: { files: 100, fileSize: session.max_file_size },
      });
    } catch (error) {
      logger.warn(
        req,
        "submission.create",
        {
          error: error?.message || String(error),
          phase: "multipart_init",
          session_id: session.id,
          year: session.year,
          team_num: team.team_num,
        },
        session.name,
      );
      return res.status(400).send("올바른 multipart 업로드 요청이 아닙니다.");
    }

    const uploadId = crypto.randomUUID();
    const tmpDir = path.join(readTMP_DIR(), uploadId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const filesInfo = [];
    const filePromises = [];
    const mimeMismatches = [];
    let totalSize = 0;
    let aborted = false;

    // 허용 확장자 파싱 (DB에 "pdf,docx" 형태로 저장, 비교 시 ".pdf" 형태로)
    const allowedExts = session.allowed_extensions
      ? session.allowed_extensions
          .split(",")
          .map((e) => {
            const s = e.trim().toLowerCase().replace(/^\./, "");
            return s ? `.${s}` : "";
          })
          .filter(Boolean)
      : [];

    busboy.on("file", (fieldname, fileStream, info) => {
      if (aborted) {
        fileStream.resume();
        return;
      }

      // 확장자 검증
      if (allowedExts.length > 0) {
        const ext = path.extname(info.filename || "").toLowerCase();
        if (!allowedExts.includes(ext)) {
          aborted = true;
          fileStream.resume();
          rmDir(tmpDir, { req });
          if (!res.headersSent) {
            logger.warn(
              req,
              "submission.create",
              {
                error: "invalid_extension",
                filename: info.filename,
                ext,
                allowed: allowedExts,
                session_id: session.id,
                team_num: team.team_num,
              },
              session.name,
            );
            res
              .status(400)
              .send(`허용되지 않는 파일 형식입니다. (허용: ${allowedExts.join(", ")})`);
          }
          return;
        }
      }

      // MIME type mismatch warning
      const MIME_MAP = {
        ".pdf": ["application/pdf"],
        ".doc": ["application/msword"],
        ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        ".jpg": ["image/jpeg"],
        ".jpeg": ["image/jpeg"],
        ".png": ["image/png"],
        ".zip": ["application/zip", "application/x-zip-compressed"],
      };
      const ext = path.extname(info.filename || "").toLowerCase();
      if (MIME_MAP[ext] && !MIME_MAP[ext].includes(info.mimeType)) {
        // 파일당 warn을 남기면 한 제출(최대 100파일)로 로그가 도배되므로 모아서 완료 시 1건만 남긴다
        mimeMismatches.push({ filename: info.filename, ext, mime: info.mimeType });
      }

      const storedName = crypto.randomUUID() + safeExt(info.filename);
      const filePath = path.join(tmpDir, storedName);
      const ws = fs.createWriteStream(filePath);
      const inlineType = inlineDisposition(info.filename, info.mimeType);
      const charsetDetector = inlineType?.startsWith("text/") ? createTextCharsetDetector() : null;
      let fileSize = 0;

      const done = new Promise((resolve, reject) => {
        ws.on("finish", () => {
          if (!aborted) {
            filesInfo.push({
              original_name: info.filename,
              stored_name: storedName,
              size: fileSize,
              mime_type: info.mimeType || "",
              text_charset: charsetDetector?.finish() || "",
            });
          }
          resolve();
        });
        ws.on("error", (err) => (aborted ? resolve() : reject(err)));
      });
      filePromises.push(done);

      fileStream.on("data", (chunk) => {
        charsetDetector?.write(chunk);
        fileSize += chunk.length;
        totalSize += chunk.length;
        if (totalSize > session.max_file_size) {
          aborted = true;
          fileStream.resume();
          ws.destroy();
          rmDir(tmpDir, { req });
          if (!res.headersSent) {
            logger.warn(
              req,
              "submission.create",
              {
                error: "file_size_exceeded",
                max_file_size: session.max_file_size,
                total_size: totalSize,
                filename: info.filename,
                session_id: session.id,
                team_num: team.team_num,
              },
              session.name,
            );
            res
              .status(413)
              .send(
                `파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`,
              );
          }
        }
      });

      fileStream.on("limit", () => {
        aborted = true;
        ws.destroy();
        rmDir(tmpDir, { req });
        if (!res.headersSent) {
          logger.warn(
            req,
            "submission.create",
            {
              error: "file_size_exceeded",
              max_file_size: session.max_file_size,
              filename: info.filename,
              session_id: session.id,
              team_num: team.team_num,
            },
            session.name,
          );
          res
            .status(413)
            .send(
              `파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`,
            );
        }
      });

      fileStream.pipe(ws);
    });

    busboy.on("filesLimit", () => {
      aborted = true;
      rmDir(tmpDir, { req });
      if (!res.headersSent) {
        logger.warn(
          req,
          "submission.create",
          {
            error: "files_limit_exceeded",
            limit: 100,
            session_id: session.id,
            team_num: team.team_num,
          },
          session.name,
        );
        res.status(400).send("파일 수가 100개를 초과했습니다.");
      }
    });

    busboy.on("error", (err) => {
      aborted = true;
      rmDir(tmpDir, { req });
      if (!res.headersSent) {
        logger.warn(
          req,
          "submission.create",
          {
            error: err?.message || "busboy_error",
            session_id: session.id,
            team_num: team.team_num,
          },
          session.name,
        );
        res.status(500).send("업로드 중 오류가 발생했습니다.");
      }
    });

    busboy.on("finish", async () => {
      if (aborted) return;

      // 모든 파일 write stream이 완료될 때까지 대기
      try {
        await Promise.all(filePromises);
      } catch (writeErr) {
        logger.warn(
          req,
          "submission.create",
          {
            error: writeErr?.message || "file_write_failed",
            phase: "write_stream",
            session_id: session.id,
            team_num: team.team_num,
          },
          session.name,
        );
        rmDir(tmpDir, { req });
        if (!res.headersSent) res.status(500).send("파일 저장 중 오류가 발생했습니다.");
        return;
      }

      if (aborted) return;
      if (filesInfo.length === 0) {
        rmDir(tmpDir, { req });
        return res.status(400).send("파일을 선택하세요.");
      }

      // 업로드 완료 시간 기준으로 마감·지각 여부 결정
      const submittedTime = now();
      if (submittedTime > effectiveLateEnd) {
        rmDir(tmpDir, { req });
        logger.warn(
          req,
          "submission.create",
          {
            error: "upload_past_deadline",
            started_at: startTime,
            submitted_at: submittedTime,
            deadline: effectiveLateEnd,
            session_id: session.id,
            team_num: team.team_num,
          },
          session.name,
        );
        if (!res.headersSent)
          return res.status(400).send("업로드 완료 시간이 제출 마감을 초과했습니다.");
        return;
      }
      const isLate = session.late_end_at && submittedTime > session.end_at ? 1 : 0;

      let movedFinalDir = null;
      let fileMoveError = null;
      try {
        options.beforeSubmissionMetadataCommit?.({
          sessionId: session.id,
          teamId: canonicalTeamId,
          teamNum: team.team_num,
        });
      } catch (error) {
        rmDir(tmpDir, { req });
        logger.warn(
          req,
          "submission.create",
          {
            error: error?.message || String(error),
            phase: "metadata_revalidation_hook",
            session_id: session.id,
            year: session.year,
            team_id: canonicalTeamId,
            team_num: team.team_num,
          },
          session.name,
        );
        return res.status(500).send("제출 정보를 확인하는 도중 오류가 발생했습니다.");
      }
      const txResult = dbRun(() => {
        const tx = db.transaction(() => {
          // Multipart streaming can take long enough for an administrator to
          // change the session or team assignment. Revalidate every authority
          // input in the same transaction that persists metadata.
          const currentSession = db.prepare("SELECT * FROM session WHERE id = ?").get(session.id);
          const currentMapping = currentSession
            ? db
                .prepare("SELECT * FROM student_team WHERE email = ? AND year = ?")
                .get(req.user.email, currentSession.year)
            : null;
          let currentCanonical = null;
          let currentMappingTeamId = Number(currentMapping?.team_id);
          if (currentSession && currentMapping) {
            currentCanonical = options.teamStore?.getById?.(canonicalTeamId) || null;
            if (!Number.isInteger(currentMappingTeamId) || currentMappingTeamId < 1) {
              const mappedCanonical = options.teamStore?.getByNumber?.(
                currentSession.year,
                currentMapping.team_num,
                { includeInactive: true },
              );
              currentMappingTeamId = Number(mappedCanonical?.id);
              currentCanonical ||= mappedCanonical;
            }
          }
          const currentCanonicalSnapshot = currentCanonical
            ? {
                id: Number(currentCanonical.id),
                year: Number(currentCanonical.year ?? currentSession?.year),
                team_num: Number(
                  currentCanonical.number ?? currentCanonical.num ?? currentMapping?.team_num,
                ),
                active: currentCanonical.active == null ? null : !!currentCanonical.active,
              }
            : null;
          const currentTarget = currentSession
            ? db
                .prepare(
                  `
          SELECT team_num, team_id FROM session_team
          WHERE session_id = ?
            AND (team_id = ? OR (team_id IS NULL AND team_num = ?))
          LIMIT 1
        `,
                )
                .get(session.id, canonicalTeamId, team.team_num)
            : null;
          let currentTargetTeamId = Number(currentTarget?.team_id);
          if (
            currentSession &&
            currentTarget &&
            (!Number.isInteger(currentTargetTeamId) || currentTargetTeamId < 1)
          ) {
            if (
              currentCanonicalSnapshot?.year === currentSession.year &&
              currentCanonicalSnapshot.team_num === currentTarget.team_num
            ) {
              currentTargetTeamId = currentCanonicalSnapshot.id;
            } else {
              const targetCanonical = options.teamStore?.getByNumber?.(
                currentSession.year,
                currentTarget.team_num,
                { includeInactive: true },
              );
              currentTargetTeamId = Number(targetCanonical?.id);
            }
          }
          const currentEffectiveLateEnd = currentSession
            ? currentSession.late_end_at || currentSession.end_at
            : null;
          const expected = {
            session: {
              id: session.id,
              year: session.year,
              start_at: session.start_at,
              end_at: session.end_at,
              late_end_at: session.late_end_at,
            },
            mapping: { team_id: canonicalTeamId, team_num: team.team_num },
            canonical_team: {
              id: canonicalTeamId,
              year: canonicalTeamYear,
              team_num: canonicalTeamNum,
              active: canonicalTeamActive,
            },
            target: { team_id: canonicalTeamId, team_num: team.team_num },
          };
          const current = {
            session: currentSession
              ? {
                  id: currentSession.id,
                  year: currentSession.year,
                  start_at: currentSession.start_at,
                  end_at: currentSession.end_at,
                  late_end_at: currentSession.late_end_at,
                }
              : null,
            mapping: currentMapping
              ? {
                  team_id: Number.isInteger(currentMappingTeamId) ? currentMappingTeamId : null,
                  team_num: currentMapping.team_num,
                }
              : null,
            canonical_team: currentCanonicalSnapshot,
            target: currentTarget
              ? {
                  team_id: Number.isInteger(currentTargetTeamId) ? currentTargetTeamId : null,
                  team_num: currentTarget.team_num,
                }
              : null,
          };
          const stale =
            !currentSession ||
            currentSession.year !== session.year ||
            currentSession.start_at !== session.start_at ||
            currentSession.end_at !== session.end_at ||
            currentSession.late_end_at !== session.late_end_at ||
            !currentMapping ||
            currentMapping.team_num !== team.team_num ||
            currentMappingTeamId !== canonicalTeamId ||
            !currentCanonicalSnapshot ||
            currentCanonicalSnapshot.id !== canonicalTeamId ||
            currentCanonicalSnapshot.year !== canonicalTeamYear ||
            currentCanonicalSnapshot.team_num !== canonicalTeamNum ||
            currentCanonicalSnapshot.active !== canonicalTeamActive ||
            !currentTarget ||
            currentTarget.team_num !== team.team_num ||
            currentTargetTeamId !== canonicalTeamId ||
            submittedTime < currentSession?.start_at ||
            submittedTime > currentEffectiveLateEnd;
          if (stale) {
            return {
              rejected: true,
              status: 409,
              message: "제출 대상 또는 기간이 변경되었습니다. 다시 시도하세요.",
              audit: {
                error: "stale_submission_preflight",
                reason: "stale_submission_preflight",
                phase: "metadata_revalidation",
                session_id: session.id,
                year: session.year,
                team_id: canonicalTeamId,
                team_num: team.team_num,
                started_at: startTime,
                submitted_at: submittedTime,
                expected,
                current,
              },
            };
          }

          // attempt_no는 같은 (session, team)의 누적 최대치 + 1. retention으로 삭제되어도 최신 row가 살아남으므로 단조 증가.
          const prevAttempt = db
            .prepare(
              "SELECT MAX(attempt_no) AS m FROM submission WHERE session_id = ? AND team_num = ?",
            )
            .get(session.id, team.team_num);
          const attemptNo = (prevAttempt?.m || 0) + 1;

          // 새 제출 INSERT
          const subResult = db
            .prepare(
              "INSERT INTO submission (session_id, team_num, team_id, submitted_by, started_at, submitted_at, total_size, is_late, attempt_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              session.id,
              team.team_num,
              canonicalTeamId,
              req.user.email,
              startTime,
              submittedTime,
              totalSize,
              isLate,
              attemptNo,
            );
          const newSubId = subResult.lastInsertRowid;
          const storageDir = path.join(
            String(session.id),
            `team-${canonicalTeamId}`,
            String(newSubId),
          );
          db.prepare("UPDATE submission SET storage_dir = ? WHERE id = ?").run(
            storageDir,
            newSubId,
          );

          // 파일 메타데이터 INSERT
          const fileStmt = db.prepare(
            "INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type, text_charset) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (const f of filesInfo) {
            fileStmt.run(
              newSubId,
              f.original_name,
              f.stored_name,
              f.size,
              f.mime_type,
              f.text_charset,
            );
          }

          // Establish the bytes at their final path before the metadata commit.
          // A crash after this rename rolls the SQLite transaction back and leaves
          // only an orphan directory, which startup cleanup removes. The inverse
          // state (committed references to bytes still under _tmp) is impossible.
          const finalDir = submissionUploadDir({
            id: newSubId,
            session_id: session.id,
            team_num: team.team_num,
            storage_dir: storageDir,
          });
          try {
            fs.mkdirSync(path.dirname(finalDir), { recursive: true });
            fs.renameSync(tmpDir, finalDir);
            movedFinalDir = finalDir;
            options.afterSubmissionFilesMoved?.({
              submissionId: Number(newSubId),
              finalDir,
              storageDir,
            });
          } catch (error) {
            fileMoveError = error;
            throw error;
          }

          // 최신 2개를 제외한 오래된 제출 조회
          const allSubs = db
            .prepare(
              "SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? AND team_num = ? ORDER BY id DESC",
            )
            .all(session.id, team.team_num);
          const toDelete = allSubs.slice(2);

          return {
            id: newSubId,
            submitted_at: submittedTime,
            is_late: isLate,
            total_size: totalSize,
            storage_dir: storageDir,
            toDelete,
          };
        });
        return tx();
      });

      if (!txResult.success) {
        logger.warn(
          req,
          "submission.create",
          {
            error: fileMoveError?.message || txResult.internalError || txResult.error,
            phase: fileMoveError ? "file_move" : "metadata_commit",
            session_id: session.id,
            year: session.year,
            team_num: team.team_num,
          },
          session.name,
        );
        if (movedFinalDir) rmDir(movedFinalDir, { req });
        else rmDir(tmpDir, { req });
        return res
          .status(txResult.status)
          .send(fileMoveError ? "파일 저장에 실패했습니다." : txResult.error);
      }
      if (txResult.result.rejected) {
        rmDir(tmpDir, { req });
        logger.warn(req, "submission.create", txResult.result.audit, session.name);
        return res.status(txResult.result.status).send(txResult.result.message);
      }

      for (const oldSubmission of txResult.result.toDelete) {
        let metadataDeleted = false;
        try {
          const deleted = db.prepare("DELETE FROM submission WHERE id = ?").run(oldSubmission.id);
          if (deleted.changes !== 1) {
            throw new Error(`expected one deleted submission row, got ${deleted.changes}`);
          }
          metadataDeleted = true;
        } catch (e) {
          logger.warn(
            req,
            "submission.retention_cleanup",
            {
              error: e.message,
              submission_id: oldSubmission.id,
              storage_dir: oldSubmission.storage_dir,
              file_preserved: true,
            },
            session.name,
          );
        }
        if (metadataDeleted) {
          const fileCleanup = rmDir(submissionUploadDir(oldSubmission), { logFailure: false });
          const detail = {
            submission_id: oldSubmission.id,
            storage_dir: oldSubmission.storage_dir,
            metadata_deleted: true,
            file_removed: fileCleanup.removed,
            ...(fileCleanup.error ? { error: fileCleanup.error } : {}),
          };
          if (fileCleanup.removed)
            logger.log(req, "submission.retention_cleanup", detail, session.name);
          else logger.warn(req, "submission.retention_cleanup", detail, session.name);
        }
      }

      if (mimeMismatches.length > 0) {
        logger.warn(
          req,
          "submission.create",
          {
            warning: "mime_mismatch",
            files: mimeMismatches.slice(0, 10),
            total: mimeMismatches.length,
            session_id: session.id,
            team_num: team.team_num,
          },
          session.name,
        );
      }
      const { toDelete, storage_dir, ...result } = txResult.result;
      logger.log(
        req,
        "submission.create",
        {
          session_id: session.id,
          team_id: canonicalTeamId,
          team_num: team.team_num,
          files: filesInfo.length,
          size: totalSize,
          is_late: isLate,
          started_at: startTime,
          submitted_at: submittedTime,
        },
        session.name,
      );
      res.json(result);
    });

    req.on("error", () => {
      aborted = true;
      rmDir(tmpDir, { req });
      if (!res.headersSent) res.status(400).send("업로드가 중단되었습니다.");
    });

    req.on("close", () => {
      if (!req.complete && !aborted && fs.existsSync(tmpDir)) {
        aborted = true;
        rmDir(tmpDir, { req });
      }
    });

    req.pipe(busboy);
  });
}
