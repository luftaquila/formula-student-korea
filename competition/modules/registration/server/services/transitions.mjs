import { assertCurrentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function createRegistrationTransitions({
  parsePositiveInteger,
  registrationRow,
  logger,
  advanceTarget,
  settingsForYear,
  dbRun,
  db,
  auditTeam,
  notifyUpcoming,
  broadcastChange,
  sendError,
}) {
  function transition(req, res, { from, to, timestampColumn, action }) {
    let row;
    try {
      const id = parsePositiveInteger(req.params.id, "대기 ID");
      row = registrationRow(id);
      if (!row) {
        logger.warn(
          req,
          action,
          {
            reason: "not_found",
            registrationId: id,
            requested: to,
          },
          String(id),
        );
        return res
          .status(404)
          .json({ code: "REGISTRATION_NOT_FOUND", message: "대기 내역을 찾을 수 없습니다." });
      }
      assertCurrentCompetitionYear(row.year);
      if (!from.includes(row.status)) {
        logger.warn(
          req,
          action,
          {
            reason: "invalid_status",
            registrationId: row.id,
            status: row.status,
            teamId: row.team_id,
          },
          String(row.id),
        );
        return res
          .status(409)
          .json({
            code: "REGISTRATION_ALREADY_PROCESSED",
            message: "이미 처리된 대기 내역입니다.",
          });
      }

      // from.includes(row.status) above already proved the row is still waiting.
      const previousAdvanceTargetId = advanceTarget(
        row.year,
        settingsForYear(row.year).notifyRank,
      )?.id;

      const placeholders = from.map(() => "?").join(",");
      const result = dbRun(() =>
        db
          .prepare(
            `
        UPDATE registration_queue
        SET status = ?, ${timestampColumn} = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status IN (${placeholders})
      `,
          )
          .run(to, row.id, ...from),
      );
      if (!result.success) {
        logger.warn(
          req,
          action,
          {
            error: result.internalError || result.error,
            registrationId: row.id,
            teamId: row.team_id,
            before: row.status,
            requested: to,
          },
          String(row.id),
        );
        return res
          .status(result.status)
          .json({ code: "REGISTRATION_TRANSITION_FAILED", message: result.error });
      }
      if (result.result.changes !== 1) {
        const latest = registrationRow(row.id);
        logger.warn(
          req,
          action,
          {
            reason: "concurrent_transition",
            registrationId: row.id,
            teamId: row.team_id,
            before: row.status,
            actual: latest?.status,
          },
          String(row.id),
        );
        return res
          .status(409)
          .json({
            code: "REGISTRATION_CONFLICT",
            message: "다른 요청에서 먼저 처리된 대기 내역입니다.",
          });
      }

      const team = {
        id: row.team_id,
        year: row.year,
        number: row.num,
        university: row.univ,
        name: row.name,
        active: row.active === 1,
      };
      logger.log(
        req,
        action,
        {
          registrationId: row.id,
          team: auditTeam(team),
          before: row.status,
          after: to,
        },
        String(row.id),
      );

      notifyUpcoming(row.year, previousAdvanceTargetId);
      broadcastChange(row.year);
      return res.status(200).json({ id: row.id, status: to });
    } catch (error) {
      logger.warn(
        req,
        action,
        {
          error: error.message,
          registrationId: row?.id || req.params.id,
          teamId: row?.team_id,
          before: row?.status,
          requested: to,
        },
        String(row?.id || req.params.id),
      );
      return sendError(res, error, "REGISTRATION_TRANSITION_FAILED");
    }
  }

  return { transition };
}
