import { isTeamActive } from "../../../../lib/team-status.mjs";

export function createScorePreflight({ dbRun, db, logger }) {
  function scoreTeamPreflight(req, res, { action, year, teamNum, context = {} }) {
    const result = dbRun(() => isTeamActive(db, year, teamNum));
    if (!result.success) {
      logger.warn(
        req,
        action,
        {
          error: result.internalError || result.error,
          reason: result.internalError || result.error,
          phase: "canonical_team_lookup",
          year,
          team_num: teamNum,
          ...context,
        },
        `#${teamNum}`,
      );
      res.status(500).send("팀 활성 상태를 확인할 수 없습니다.");
      return false;
    }
    if (!result.result) {
      logger.warn(
        req,
        action,
        {
          error: "inactive_or_missing_team",
          reason: "inactive_or_missing_team",
          phase: "canonical_team_lookup",
          year,
          team_num: teamNum,
          ...context,
        },
        `#${teamNum}`,
      );
      res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
      return false;
    }
    return true;
  }

  function parseScoreYear(value) {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2000 && year <= 2099 ? year : null;
  }

  /* ============================================
   헬퍼
   ============================================ */
  function validateKey(key, label) {
    if (!key || typeof key !== "string" || key.trim() === "") return `${label}이(가) 비어있습니다.`;
    if (key.length > 50) return `${label}이(가) 너무 깁니다.`;
    return null;
  }

  return { scoreTeamPreflight, parseScoreYear, validateKey };
}
