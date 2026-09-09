import {
  parseCompetitionYear,
  assertCurrentCompetitionYear,
} from "../../../../../shared/common/competition-year.mjs";

export function registerSettingsRoutes({
  app,
  settingsForYear,
  logger,
  sendError,
  smsClient,
  dbRun,
  db,
  broadcastChange,
}) {
  app.get("/api/settings", (req, res) => {
    try {
      res.json(settingsForYear(parseCompetitionYear(req.query.year)));
    } catch (error) {
      logger.warn(req, "registration.settings_view", {
        requestedYear: req.query.year,
        error: error.message,
      });
      sendError(res, error, "REGISTRATION_SETTINGS_FAILED");
    }
  });

  app.patch("/api/settings", (req, res) => {
    let year;
    try {
      year = assertCurrentCompetitionYear(req.body?.year);
      const changes = {};
      if (Object.hasOwn(req.body || {}, "open")) {
        if (typeof req.body.open !== "boolean")
          throw Object.assign(new Error("open은 불리언이어야 합니다."), { status: 400 });
        changes.open = req.body.open ? 1 : 0;
      }
      if (Object.hasOwn(req.body || {}, "sms")) {
        if (typeof req.body.sms !== "boolean")
          throw Object.assign(new Error("sms는 불리언이어야 합니다."), { status: 400 });
        if (req.body.sms && !smsClient.isAvailable()) {
          logger.warn(
            req,
            "registration.settings_update",
            {
              reason: "sms_configuration_unavailable",
              year,
              requested: { sms: true },
            },
            String(year),
          );
          return res.status(400).json({
            code: "SMS_CONFIGURATION_UNAVAILABLE",
            message: "SMS 설정이 되어 있지 않습니다. 이메일/SMS 서비스에서 설정해 주세요.",
          });
        }
        changes.sms = req.body.sms ? 1 : 0;
      }
      if (Object.hasOwn(req.body || {}, "notifyRank")) {
        const rank = Number(req.body.notifyRank);
        if (!Number.isInteger(rank) || rank < 1 || rank > 10) {
          throw Object.assign(new Error("사전 안내 순번은 1~10 사이여야 합니다."), { status: 400 });
        }
        changes.notify_rank = rank;
      }
      if (!Object.keys(changes).length)
        throw Object.assign(new Error("변경할 설정이 없습니다."), { status: 400 });

      const before = settingsForYear(year);
      const result = dbRun(() =>
        db.transaction(() => {
          db.prepare(
            `
          INSERT OR IGNORE INTO registration_settings (year, open, sms, notify_rank)
          VALUES (?, 0, 0, 3)
        `,
          ).run(year);
          const columns = Object.keys(changes);
          db.prepare(
            `
          UPDATE registration_settings
          SET ${columns.map((column) => `${column} = ?`).join(", ")},
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE year = ?
        `,
          ).run(...columns.map((column) => changes[column]), year);
        })(),
      );
      if (!result.success) {
        logger.warn(
          req,
          "registration.settings_update",
          { error: result.internalError || result.error, year, before, requested: req.body },
          String(year),
        );
        return res
          .status(result.status)
          .json({ code: "REGISTRATION_SETTINGS_FAILED", message: result.error });
      }
      const after = settingsForYear(year);
      logger.log(req, "registration.settings_update", { year, before, after }, String(year));
      broadcastChange(year);
      return res.json(after);
    } catch (error) {
      logger.warn(
        req,
        "registration.settings_update",
        { error: error.message, year, requested: req.body },
        String(year || "settings"),
      );
      return sendError(res, error, "REGISTRATION_SETTINGS_FAILED");
    }
  });
}
