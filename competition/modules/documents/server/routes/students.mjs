import { serviceUrl } from "../../../../../shared/server/services.mjs";
import { validateYear } from "../../../../../shared/common/validation.mjs";

export function registerStudentsRoutes({ app, logger, db, dbRun, launchOpenSessionNotification }) {
  // GET /api/admin/students - auth 서비스에서 student 역할 사용자 목록 조회
  app.get("/api/admin/students", async (req, res) => {
    try {
      const authRes = await fetch(`${serviceUrl("auth")}/api/internal/users`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
        signal: AbortSignal.timeout(5000),
      });
      if (!authRes.ok) {
        logger.warn(req, "auth.fetch", {
          error: "auth fetch non-ok",
          status: authRes.status,
          body: await authRes.text().catch(() => ""),
        });
        return res.status(502).send("계정 서비스 연결 실패");
      }
      const users = await authRes.json();
      const students = users.filter((u) => u.role === "student" && u.active);
      res.json(
        students.map((u) => ({
          email: u.email,
          name: u.name,
          realname: u.realname,
          phone: u.phone,
        })),
      );
    } catch (e) {
      logger.warn(req, "auth.fetch", { error: e.message });
      res.status(502).send("계정 서비스 연결 실패");
    }
  });

  // GET /api/admin/student-teams - 학생-팀 매핑 목록
  app.get("/api/admin/student-teams", (req, res) => {
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = year
      ? db.prepare("SELECT * FROM student_team WHERE year = ? ORDER BY team_num").all(year)
      : db.prepare("SELECT * FROM student_team ORDER BY year DESC, team_num").all();
    res.json(rows);
  });

  // POST /api/admin/student-teams - 학생-팀 매핑 추가
  app.post("/api/admin/student-teams", (req, res) => {
    const { email, team_num, year } = req.body;
    if (!email?.trim()) return res.status(400).send("이메일을 입력하세요.");
    const numTeam = Number(team_num);
    if (!Number.isInteger(numTeam) || numTeam < 1)
      return res.status(400).send("올바르지 않은 팀 번호입니다.");
    const yearCheck = validateYear(year);
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    const numYear = yearCheck.value;

    const result = dbRun(() =>
      db
        .prepare("INSERT INTO student_team (email, team_num, year) VALUES (?, ?, ?)")
        .run(email.trim().toLowerCase(), numTeam, numYear),
    );

    if (!result.success) {
      if (result.error.includes("UNIQUE")) {
        logger.warn(
          req,
          "student_team.create",
          { error: "duplicate", team_num: numTeam, year: numYear },
          email.trim().toLowerCase(),
        );
        return res.status(400).send("이미 등록된 이메일이거나 해당 팀에 이미 학생이 있습니다.");
      }
      logger.warn(
        req,
        "student_team.create",
        { error: result.internalError || result.error },
        email.trim().toLowerCase(),
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "student_team.create",
      { team_num: Number(team_num), year: Number(year) },
      email.trim().toLowerCase(),
    );
    res
      .status(201)
      .json({ email: email.trim().toLowerCase(), team_num: Number(team_num), year: Number(year) });

    launchOpenSessionNotification(req, email.trim().toLowerCase(), numTeam, numYear);
  });

  // DELETE /api/admin/student-teams/:email/:year - 학생-팀 매핑 삭제
  app.delete("/api/admin/student-teams/:email/:year", (req, res) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year)) return res.status(400).send("올바르지 않은 연도입니다.");
    const email = decodeURIComponent(req.params.email);
    const result = dbRun(() =>
      db.transaction(() => {
        const mapping = db
          .prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?")
          .get(email, year);
        if (!mapping) return { mapping: null, changes: 0 };
        const deleted = db
          .prepare("DELETE FROM student_team WHERE email = ? AND year = ?")
          .run(email, year);
        return { mapping, changes: deleted.changes };
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "student_team.delete",
        {
          error: result.internalError || result.error,
          reason: result.internalError || result.error,
          phase: "mapping_preflight",
          year,
        },
        email,
      );
      return res.status(result.status).send(result.error);
    }
    if (result.result.changes === 0) {
      logger.warn(
        req,
        "student_team.delete",
        {
          error: "mapping_not_found",
          reason: "mapping_not_found",
          year,
        },
        email,
      );
      return res.status(404).send("매핑을 찾을 수 없습니다.");
    }
    logger.log(
      req,
      "student_team.delete",
      { year, team_num: result.result.mapping.team_num },
      email,
    );
    res.status(200).send();
  });
}
