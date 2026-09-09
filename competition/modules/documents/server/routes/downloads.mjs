import fs from "fs";

export function registerDownloadsRoutes({
  app,
  db,
  logger,
  submissionFilePath,
  isInitialDownload,
  setFileResponseHeaders,
  sanitize,
  createArchive,
}) {
  // GET /api/submissions/:subId/files/:fileId - 파일 다운로드
  app.get("/api/submissions/:subId/files/:fileId", async (req, res) => {
    const sub = db
      .prepare(
        `
    SELECT sub.*, s.year AS session_year
    FROM submission sub JOIN session s ON s.id = sub.session_id
    WHERE sub.id = ?
  `,
      )
      .get(Number(req.params.subId));
    if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
    const team = db
      .prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
      .get(req.user.email, sub.session_year);
    if (!team) {
      logger.warn(req, "file.download", {
        error: "no_team_for_year",
        sub_id: sub.id,
        year: sub.session_year,
      });
      return res.status(403).send("팀이 등록되지 않았습니다.");
    }
    if (sub.team_num !== team.team_num) {
      logger.warn(
        req,
        "file.download",
        {
          error: "wrong_team",
          year: sub.session_year,
          sub_team: sub.team_num,
          my_team: team.team_num,
        },
        `#${sub.team_num}`,
      );
      return res.status(403).send("권한이 없습니다.");
    }

    // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
    const isTarget = db
      .prepare(
        "SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?",
      )
      .get(sub.session_id, team.team_num, team.year);
    if (!isTarget) {
      logger.warn(
        req,
        "file.download",
        { error: "not_target", year: sub.session_year, session_id: sub.session_id },
        `#${sub.team_num}`,
      );
      return res.status(403).send("권한이 없습니다.");
    }

    const file = db
      .prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?")
      .get(Number(req.params.fileId), sub.id);
    if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

    const filePath = submissionFilePath(sub, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

    const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
    if (isInitialDownload(req))
      logger.log(
        req,
        "file.download",
        {
          session_name: session?.name,
          year: sub.session_year,
          team_num: sub.team_num,
          file: file.original_name,
        },
        `#${sub.team_num}`,
      );
    await setFileResponseHeaders(res, file, filePath);
    res.sendFile(filePath);
  });

  // GET /api/submissions/:subId/zip - 본인 제출 파일 전체 압축 다운로드
  app.get("/api/submissions/:subId/zip", async (req, res) => {
    const sub = db
      .prepare(
        `
    SELECT sub.*, s.year AS session_year
    FROM submission sub JOIN session s ON s.id = sub.session_id
    WHERE sub.id = ?
  `,
      )
      .get(Number(req.params.subId));
    if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
    const team = db
      .prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
      .get(req.user.email, sub.session_year);
    if (!team) {
      logger.warn(req, "file.zip", {
        error: "no_team_for_year",
        sub_id: sub.id,
        year: sub.session_year,
      });
      return res.status(403).send("팀이 등록되지 않았습니다.");
    }
    if (sub.team_num !== team.team_num) {
      logger.warn(
        req,
        "file.zip",
        {
          error: "wrong_team",
          year: sub.session_year,
          sub_team: sub.team_num,
          my_team: team.team_num,
        },
        `#${sub.team_num}`,
      );
      return res.status(403).send("권한이 없습니다.");
    }

    // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
    const isTarget = db
      .prepare(
        "SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?",
      )
      .get(sub.session_id, team.team_num, team.year);
    if (!isTarget) {
      logger.warn(
        req,
        "file.zip",
        { error: "not_target", year: sub.session_year, session_id: sub.session_id },
        `#${sub.team_num}`,
      );
      return res.status(403).send("권한이 없습니다.");
    }

    const files = db.prepare("SELECT * FROM submission_file WHERE submission_id = ?").all(sub.id);
    if (files.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

    const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
    const zipName = `${sanitize(session?.name || String(sub.session_id))}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    );

    const archive = createArchive("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => {
      logger.warn(
        req,
        "file.zip",
        { error: err.message, year: sub.session_year, submission_id: sub.id },
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
    logger.log(
      req,
      "file.zip",
      {
        session_name: session?.name,
        year: sub.session_year,
        team_num: sub.team_num,
        files: files.length,
      },
      `#${sub.team_num}`,
    );
  });
}
