import fs from "fs";

export function registerAdminDownloadsRoutes({
  app,
  db,
  fetchEntries,
  sanitize,
  submissionFilePath,
  createArchive,
  logger,
  isInitialDownload,
  setFileResponseHeaders,
}) {
  // GET /api/admin/sessions/:id/archive - 세션별 전체 압축 다운로드
  app.get("/api/admin/sessions/:id/archive", async (req, res) => {
    const id = Number(req.params.id);
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
    if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

    // entry 서비스에서 팀 정보 조회
    const entries = await fetchEntries(session.year, req, "session.archive");

    const subs = db
      .prepare(
        `
    SELECT sub.id, sub.session_id, sub.team_num, sub.storage_dir FROM submission sub
    INNER JOIN (
      SELECT session_id, team_num, MAX(id) AS max_id
      FROM submission
      WHERE session_id = ?
      GROUP BY session_id, team_num
    ) latest ON sub.id = latest.max_id
  `,
      )
      .all(id);

    const sessionName = sanitize(session.name);
    const archiveFiles = [];
    const subById = new Map(subs.map((sub) => [sub.id, sub]));
    const subIds = subs.map((sub) => sub.id);
    const files = subIds.length
      ? db
          .prepare(
            `SELECT submission_id, original_name, stored_name FROM submission_file WHERE submission_id IN (${subIds.map(() => "?").join(",")})`,
          )
          .all(...subIds)
      : [];

    for (const f of files) {
      const sub = subById.get(f.submission_id);
      if (!sub) continue;
      const diskPath = submissionFilePath(sub, f.stored_name);
      if (fs.existsSync(diskPath)) {
        const entry = entries[sub.team_num];
        const teamFolder = entry
          ? `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`
          : String(sub.team_num);
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
      `attachment; filename*=UTF-8''${encodeURIComponent(`${sessionName}.zip`)}`,
    );

    const archive = createArchive("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => {
      logger.warn(req, "session.archive", { error: err.message, session_id: id }, session.name);
      if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
    });
    archive.pipe(res);

    for (const f of archiveFiles) {
      archive.file(f.diskPath, { name: f.zipPath });
    }

    await archive.finalize();
    logger.log(
      req,
      "session.archive",
      { session_name: session.name, teams: subs.length, files: archiveFiles.length },
      session.name,
    );
  });

  // GET /api/admin/submissions/:subId/files/:fileId - 관리자 파일 다운로드
  app.get("/api/admin/submissions/:subId/files/:fileId", async (req, res) => {
    const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
    if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
    const session = db.prepare("SELECT name, year FROM session WHERE id = ?").get(sub.session_id);
    if (!session) return res.status(404).send("제출을 찾을 수 없습니다.");

    const file = db
      .prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?")
      .get(Number(req.params.fileId), sub.id);
    if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

    const filePath = submissionFilePath(sub, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

    if (isInitialDownload(req))
      logger.log(
        req,
        "file.admin_download",
        {
          session_name: session?.name,
          year: session.year,
          team_num: sub.team_num,
          file: file.original_name,
        },
        `#${sub.team_num}`,
      );
    await setFileResponseHeaders(res, file, filePath);
    res.sendFile(filePath);
  });

  // GET /api/admin/submissions/:subId/zip - 제출 파일 전체 압축 다운로드
  app.get("/api/admin/submissions/:subId/zip", async (req, res) => {
    const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
    if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");

    const session = db.prepare("SELECT name, year FROM session WHERE id = ?").get(sub.session_id);
    if (!session) return res.status(404).send("제출을 찾을 수 없습니다.");

    const files = db.prepare("SELECT * FROM submission_file WHERE submission_id = ?").all(sub.id);
    if (files.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

    const sessionName = sanitize(session?.name || String(sub.session_id));

    // entry 서비스에서 팀 정보 조회
    let teamLabel = String(sub.team_num);
    if (session?.year) {
      const entries = await fetchEntries(session.year, req, "file.admin_zip");
      const entry = entries[sub.team_num];
      if (entry) teamLabel = `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`;
    }

    const zipName = `${sessionName}_${teamLabel}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    );

    const archive = createArchive("zip", { zlib: { level: 5 } });
    let archiveFailed = false;
    archive.on("error", (err) => {
      archiveFailed = true;
      logger.warn(
        req,
        "file.admin_zip",
        {
          error: err.message,
          year: session.year,
          submission_id: sub.id,
          team_num: sub.team_num,
        },
        `#${sub.team_num}`,
      );
      if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
    });
    archive.pipe(res);

    for (const f of files) {
      const filePath = submissionFilePath(sub, f.stored_name);
      if (fs.existsSync(filePath)) {
        // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
        archive.file(filePath, { name: sanitize(f.original_name) });
      }
    }

    // 스트리밍 중 archiver 에러가 나면 error 핸들러가 warn을 남기므로, 완료를 확인한 뒤에만 성공 로그를 남긴다
    await archive.finalize();
    if (archiveFailed) return;
    logger.log(
      req,
      "file.admin_zip",
      {
        session_name: session?.name,
        year: session.year,
        team_num: sub.team_num,
        files: files.length,
      },
      `#${sub.team_num}`,
    );
  });
}
