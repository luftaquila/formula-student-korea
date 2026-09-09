import { validateYear } from "../../../../../shared/common/validation.mjs";

export function registerSessionsRoutes({ app, db, logger }) {
  /* ============================================
   학생 API
   ============================================ */

  // GET /api/sessions - 내 팀에 열린 세션 목록
  app.get("/api/sessions", (req, res) => {
    let team;
    if (req.query.year !== undefined) {
      const yearCheck = validateYear(req.query.year);
      if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
      team = db
        .prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
        .get(req.user.email, yearCheck.value);
    } else {
      team = db
        .prepare(
          "SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1",
        )
        .get(req.user.email);
    }
    if (!team) return res.json({ team: null, sessions: [] });

    const rows = db
      .prepare(
        `
    SELECT s.*, st.team_num AS target,
      sub.id AS sub_id, sub.submitted_at AS sub_submitted_at, sub.is_late AS sub_is_late
    FROM session s
    JOIN session_team st ON st.session_id = s.id AND st.team_num = ?
    LEFT JOIN (
      SELECT session_id, team_num, id, submitted_at, is_late,
        ROW_NUMBER() OVER (PARTITION BY session_id, team_num ORDER BY id DESC) AS rn
      FROM submission
    ) sub ON sub.session_id = s.id AND sub.team_num = ? AND sub.rn = 1
    WHERE s.year = ?
    ORDER BY s.end_at ASC
  `,
      )
      .all(team.team_num, team.team_num, team.year);

    const result = rows.map(({ sub_id, sub_submitted_at, sub_is_late, ...s }) => ({
      ...s,
      submission: sub_id
        ? { id: sub_id, submitted_at: sub_submitted_at, is_late: sub_is_late }
        : null,
    }));

    res.json({ team, sessions: result });
  });

  // GET /api/sessions/:id - 세션 상세
  app.get("/api/sessions/:id", (req, res) => {
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
    if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

    // cross-year IDOR 방지: 세션 연도의 팀 매핑으로 해석한다(팀 번호는 연도별 재할당되므로
    // 같은 번호를 쓰는 타 연도=다른 대학 팀의 세션을 순회 접근할 수 없다).
    const team = db
      .prepare("SELECT * FROM student_team WHERE email = ? AND year = ?")
      .get(req.user.email, session.year);
    if (!team) {
      logger.warn(
        req,
        "session.view",
        { error: "no_team_for_year", session_id: session.id, year: session.year },
        session.name,
      );
      return res.status(403).send("대상 팀이 아닙니다.");
    }
    const isTarget = db
      .prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?")
      .get(session.id, team.team_num);
    if (!isTarget) {
      logger.warn(
        req,
        "session.view",
        { error: "not_target", session_id: session.id },
        session.name,
      );
      return res.status(403).send("대상 팀이 아닙니다.");
    }

    // 최신 제출
    const sub = db
      .prepare(
        `
    SELECT id, submitted_at, total_size, is_late FROM submission
    WHERE session_id = ? AND team_num = ?
    ORDER BY id DESC LIMIT 1
  `,
      )
      .get(session.id, team.team_num);

    let files = [];
    if (sub) {
      files = db
        .prepare(
          "SELECT id, original_name, size, mime_type FROM submission_file WHERE submission_id = ?",
        )
        .all(sub.id);
    }

    res.json({ session, team_num: team.team_num, submission: sub || null, files });
  });
}
