import { validateYear } from "../../../../../shared/common/validation.mjs";
import path from "path";
import fs from "fs";

export function registerYearsRoutes({
  app,
  dbRun,
  db,
  logger,
  UPLOADS_DIR,
  rmDir,
  logCleanupFailures,
  fetchEntries,
  submissionFilePath,
  sanitize,
  createArchive,
}) {
  /* ============================================
   Year-level Admin API (연도별 관리)
   ============================================ */

  // DELETE /api/admin/years/:year/files - 연도별 파일 데이터 삭제 (제출 기록 유지)
  app.delete("/api/admin/years/:year/files", (req, res) => {
    const yearCheck = validateYear(req.params.year);
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    const year = yearCheck.value;

    const txResult = dbRun(() => {
      return db.transaction(() => {
        const sessions = db.prepare("SELECT id FROM session WHERE year = ? ORDER BY id").all(year);
        if (sessions.length === 0) return { sessions, fileCount: 0 };
        const sessionIds = sessions.map((s) => s.id);
        const placeholders = sessionIds.map(() => "?").join(",");
        const subIds = db
          .prepare(`SELECT id FROM submission WHERE session_id IN (${placeholders})`)
          .all(...sessionIds)
          .map((s) => s.id);
        let fileCount = 0;
        if (subIds.length) {
          const subPlaceholders = subIds.map(() => "?").join(",");
          fileCount = db
            .prepare(`DELETE FROM submission_file WHERE submission_id IN (${subPlaceholders})`)
            .run(...subIds).changes;
        }
        return { sessions, fileCount };
      })();
    });

    if (!txResult.success) {
      logger.warn(req, "year.purge_files", {
        error: txResult.internalError || txResult.error,
        reason: txResult.internalError || txResult.error,
        phase: "year_purge_preflight",
        year,
      });
      return res.status(txResult.status).send(txResult.error);
    }
    const { sessions, fileCount } = txResult.result;
    if (sessions.length === 0) {
      logger.warn(
        req,
        "year.purge_files",
        {
          error: "year_has_no_sessions",
          reason: "year_has_no_sessions",
          year,
        },
        String(year),
      );
      return res.status(404).send("해당 연도의 세션이 없습니다.");
    }

    // 트랜잭션 성공 후 디스크 파일 삭제
    const cleanup = sessions.map((session) => {
      const directory = path.join(UPLOADS_DIR, String(session.id));
      return { session_id: session.id, directory, ...rmDir(directory, { logFailure: false }) };
    });

    logger.log(req, "year.purge_files", {
      year,
      sessions: sessions.length,
      files: fileCount,
      file_cleanup: cleanup,
    });
    logCleanupFailures(
      req,
      "year.purge_files",
      String(year),
      { year, sessions: sessions.length, files: fileCount },
      cleanup,
    );
    res.json({ sessions: sessions.length, files: fileCount });
  });

  // GET /api/admin/years/:year/archive - 연도별 전체 압축 다운로드
  app.get("/api/admin/years/:year/archive", async (req, res) => {
    const yearCheck = validateYear(req.params.year);
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    const year = yearCheck.value;

    const sessions = db
      .prepare("SELECT * FROM session WHERE year = ? ORDER BY end_at ASC")
      .all(year);
    if (sessions.length === 0) return res.status(404).send("해당 연도의 세션이 없습니다.");

    // entry 서비스에서 팀 정보 조회 (실패 시 빈 객체 — graceful degradation)
    const entries = await fetchEntries(year, req, "year.archive");

    // 각 세션의 최신 제출 + 파일 조회
    const archiveFiles = [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const files = db
      .prepare(
        `
    WITH latest AS (
      SELECT id, session_id, team_num, storage_dir
      FROM (
        SELECT sub.id, sub.session_id, sub.team_num, sub.storage_dir,
               ROW_NUMBER() OVER (PARTITION BY sub.session_id, sub.team_num ORDER BY sub.id DESC) AS rn
        FROM submission sub
        JOIN session s ON s.id = sub.session_id
        WHERE s.year = ?
      )
      WHERE rn = 1
    )
    SELECT latest.id AS submission_id, latest.session_id, latest.team_num, latest.storage_dir, f.original_name, f.stored_name
    FROM latest
    JOIN submission_file f ON f.submission_id = latest.id
    ORDER BY latest.session_id, latest.team_num, f.id
  `,
      )
      .all(year);

    for (const f of files) {
      const s = sessionById.get(f.session_id);
      if (!s) continue;
      const diskPath = submissionFilePath(
        {
          id: f.submission_id,
          session_id: f.session_id,
          team_num: f.team_num,
          storage_dir: f.storage_dir,
        },
        f.stored_name,
      );
      if (fs.existsSync(diskPath)) {
        const entry = entries[f.team_num];
        const sessionName = sanitize(s.name);
        const teamFolder = entry
          ? sanitize(`${f.team_num}_${entry.univ}_${entry.team}`)
          : String(f.team_num);
        // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
        archiveFiles.push({
          diskPath,
          zipPath: `${sessionName}/${teamFolder}/${sanitize(f.original_name)}`,
        });
      }
    }

    if (archiveFiles.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`FSK_${year}_documents.zip`)}`,
    );

    const archive = createArchive("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => {
      logger.warn(req, "year.archive", { error: err.message, year });
      if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
    });
    archive.pipe(res);

    for (const f of archiveFiles) {
      archive.file(f.diskPath, { name: f.zipPath });
    }

    await archive.finalize();
    logger.log(req, "year.archive", {
      year,
      sessions: sessions.length,
      files: archiveFiles.length,
    });
  });
}
