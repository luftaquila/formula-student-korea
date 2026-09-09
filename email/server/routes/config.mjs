import { requireInternalRequest } from "../../../shared/server/express-setup.mjs";

export function registerConfigRoutes({
  app,
  dbRun,
  getAllConfig,
  logger,
  maskValue,
  db,
  CONFIG_KEYS,
  MASKED_KEYS,
  getConfig,
  CONFIG_GROUPS,
}) {
  app.get("/api/config", (req, res) => {
    const result = dbRun(() => getAllConfig());
    if (!result.success) {
      logger.warn(req, "config.list", { error: result.internalError || result.error });
      return res.status(result.status).send(result.error);
    }
    const configs = {};
    for (const { key, value } of result.result) {
      configs[key] = maskValue(key, value);
    }
    res.json(configs);
  });

  app.put("/api/config", (req, res) => {
    const { configs } = req.body;
    if (!Array.isArray(configs)) {
      logger.warn(req, "config.update", { error: "configs 배열 누락" });
      return res.status(400).send("configs 배열이 필요합니다.");
    }

    const updated = [];
    const result = dbRun(() => {
      const stmt = db.prepare("UPDATE config SET value = ? WHERE key = ?");
      for (const { key, value } of configs) {
        if (!CONFIG_KEYS.includes(key)) continue;
        if (typeof value !== "string") continue; // skip null/undefined/non-string (config 값은 TEXT)
        if (value === "") continue; // skip empty (unchanged masked field)
        if (MASKED_KEYS.has(key) && value.startsWith("****")) continue; // skip masked placeholder
        stmt.run(value, key);
        updated.push(key);
      }
    });

    if (!result.success) {
      logger.warn(req, "config.update", {
        error: result.internalError || result.error,
        keys: updated,
      });
      return res.status(result.status).send(result.error);
    }

    // 한 번의 저장은 한 행으로 — 키당 행을 남기면 성공/실패 로그 형태도 어긋난다(실패는 배치 1행).
    if (updated.length > 0) {
      logger.log(req, "config.update", {
        updated: updated.map((key) => ({ key, value: maskValue(key, getConfig(key)) })),
      });
    }
    res.json({ updated });
  });

  app.post("/api/config/reset", (req, res) => {
    const { group } = req.body;
    const keys = CONFIG_GROUPS[group];
    if (!keys) {
      logger.warn(req, "config.reset", { error: "유효하지 않은 group", group });
      return res.status(400).send("유효하지 않은 그룹입니다. (brevo | sms)");
    }

    const result = dbRun(() => {
      const stmt = db.prepare("UPDATE config SET value = '' WHERE key = ?");
      for (const key of keys) stmt.run(key);
    });

    if (!result.success) {
      logger.warn(req, "config.reset", { error: result.internalError || result.error, group });
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "config.reset", { group, keys });
    res.json({ reset: keys });
  });

  /* ============================================
   Internal API: SMS Config for queue service
   ============================================ */
  app.get("/api/internal/sms-config", (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const result = dbRun(() => {
      const configs = {};
      for (const key of CONFIG_KEYS.filter(
        (k) => k.startsWith("naver_") || k === "phone_number_sms_sender",
      )) {
        configs[key] = getConfig(key);
      }
      return configs;
    });
    if (!result.success) {
      logger.warn(req, "sms_config.fetch", { error: result.internalError || result.error });
      return res.status(result.status).send(result.error);
    }
    res.json(result.result);
  });
}
