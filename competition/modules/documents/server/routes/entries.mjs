import { validateYear } from "../../../../../shared/common/validation.mjs";
import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function registerEntriesRoutes({ app, db, fetchEntries }) {
  // Documents에서는 엔트리 활성 상태와 무관하게 계정 할당과 제출을 허용한다.
  // 학생에게는 자신의 매핑 팀만, 운영 권한에는 관리에 필요한 전체 목록만 반환한다.
  // 두 경로 모두 브라우저가 Entry의 관리자 전용 includeInactive API를 직접 호출하지
  // 않도록 Documents가 내부 서비스 자격으로 조회한다.
  app.get("/api/entries", async (req, res) => {
    const yearCheck = validateYear(req.query.year || currentCompetitionYear());
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    const mapping = db
      .prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?")
      .get(req.user.email, yearCheck.value);
    if (!mapping) return res.json({});

    const entries = await fetchEntries(yearCheck.value, req, "entry.student_lookup");
    const entry = entries[mapping.team_num];
    res.json(entry ? { [mapping.team_num]: entry } : {});
  });

  app.get("/api/admin/entries", async (req, res) => {
    const yearCheck = validateYear(req.query.year || currentCompetitionYear());
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    res.json(await fetchEntries(yearCheck.value, req, "entry.admin_list"));
  });
}
