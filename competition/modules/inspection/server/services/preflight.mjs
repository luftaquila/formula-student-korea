import { isTeamActive } from "../../../../lib/team-status.mjs";

export function createInspectionPreflight({ logger, dbRun, db }) {
  function auditRejection(req, action, detail, target) {
    logger.warn(
      req,
      action,
      {
        error: detail.error,
        reason: detail.reason || detail.error,
        ...detail,
      },
      target,
    );
  }

  function teamPreflight(req, res, { action, year, teamNum, missingStatus = 409 }) {
    const result = dbRun(() => isTeamActive(db, year, teamNum));
    if (!result.success) {
      auditRejection(
        req,
        action,
        {
          error: result.internalError || result.error,
          phase: "canonical_team_lookup",
          year,
          team_num: teamNum,
        },
        `#${teamNum}`,
      );
      res.status(500).send("팀 활성 상태를 확인할 수 없습니다.");
      return false;
    }
    if (!result.result) {
      auditRejection(
        req,
        action,
        {
          error: "inactive_or_missing_team",
          phase: "canonical_team_lookup",
          year,
          team_num: teamNum,
        },
        `#${teamNum}`,
      );
      res
        .status(missingStatus)
        .send(
          missingStatus === 404
            ? "엔트리를 찾을 수 없습니다."
            : "비활성화된 엔트리는 수정할 수 없습니다.",
        );
      return false;
    }
    return true;
  }

  function templateNodePreflight(req, res, { action, id, columns }) {
    const result = dbRun(() =>
      db.prepare(`SELECT ${columns} FROM sheet_template WHERE id = ?`).get(id),
    );
    if (!result.success) {
      auditRejection(
        req,
        action,
        {
          error: result.internalError || result.error,
          phase: "template_lookup",
          template_id: id,
        },
        `template:${id}`,
      );
      res.status(500).send("템플릿을 확인할 수 없습니다.");
      return null;
    }
    if (!result.result) {
      auditRejection(
        req,
        action,
        {
          error: "template_not_found",
          phase: "template_lookup",
          template_id: id,
        },
        `template:${id}`,
      );
      res
        .status(404)
        .send(
          action === "template.delete" ? "노드를 찾을 수 없습니다." : "항목을 찾을 수 없습니다.",
        );
      return null;
    }
    return result.result;
  }

  function mutationTemplatePreflight(req, res, { action, id, year, level }) {
    const levelClause = level ? " AND level = ?" : "";
    const result = dbRun(() =>
      db
        .prepare(
          `SELECT id, name, answer_type, calculation FROM sheet_template WHERE id = ? AND year = ?${levelClause}`,
        )
        .get(...(level ? [id, year, level] : [id, year])),
    );
    if (!result.success) {
      auditRejection(
        req,
        action,
        {
          error: result.internalError || result.error,
          phase: "template_lookup",
          year,
          template_id: id,
        },
        `template:${id}`,
      );
      res.status(500).send("템플릿을 확인할 수 없습니다.");
      return null;
    }
    if (!result.result) {
      auditRejection(
        req,
        action,
        {
          error: "template_not_found",
          phase: "template_lookup",
          year,
          template_id: id,
          ...(level ? { expected_level: level } : {}),
        },
        `template:${id}`,
      );
      res
        .status(400)
        .send(
          level === "category"
            ? "해당 연도에 존재하지 않는 카테고리입니다."
            : "해당 연도에 존재하지 않는 항목입니다.",
        );
      return null;
    }
    return result.result;
  }

  return { teamPreflight, templateNodePreflight, mutationTemplatePreflight };
}
