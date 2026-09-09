export function registerSettingsRoutes({
  app,
  validateInspection,
  dbRun,
  getInspectionSettings,
  logger,
  smsClient,
  db,
  inspectionSettingKey,
}) {
  /* ============================================
   API 라우트: 설정
   ============================================ */

  // GET /api/admin/settings/:type - 검차별 SMS/취소 페널티 설정 조회
  app.get("/api/admin/settings/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) return res.status(400).send(typeValidation.error);

    const result = dbRun(() => getInspectionSettings(typeValidation.value));
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // PATCH /api/admin/settings/:type - 검차별 SMS/취소 페널티 설정 변경
  app.patch("/api/admin/settings/:type", (req, res) => {
    const type = req.params.type;
    const body = req.body || {};
    const rejectUpdate = (reason, message) => {
      logger.warn(
        req,
        "settings.update",
        {
          error: "settings_validation_failed",
          reason,
          inspection: type,
          requested: body,
        },
        type,
      );
      return res.status(400).send(message);
    };
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) return rejectUpdate("invalid_inspection", typeValidation.error);

    const allowedFields = new Set(["sms", "smsRank", "cancelPenalty"]);
    const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0)
      return rejectUpdate("unknown_fields", "알 수 없는 설정 항목입니다.");
    const fields = [...allowedFields].filter((field) => Object.hasOwn(body, field));
    if (fields.length === 0) return rejectUpdate("empty_update", "변경할 설정이 없습니다.");
    if (Object.hasOwn(body, "sms") && typeof body.sms !== "boolean") {
      return rejectUpdate("invalid_sms", "SMS 설정은 불리언이어야 합니다.");
    }
    if (
      Object.hasOwn(body, "smsRank") &&
      (!Number.isInteger(body.smsRank) || body.smsRank < 1 || body.smsRank > 10)
    ) {
      return rejectUpdate("invalid_sms_rank", "알림 순번은 1~10 사이의 정수여야 합니다.");
    }
    if (
      Object.hasOwn(body, "cancelPenalty") &&
      (!Number.isInteger(body.cancelPenalty) || body.cancelPenalty < 0 || body.cancelPenalty > 60)
    ) {
      return rejectUpdate("invalid_cancel_penalty", "페널티 시간은 0~60분 사이의 정수여야 합니다.");
    }
    if (body.sms === true && !smsClient.isAvailable()) {
      logger.warn(
        req,
        "settings.sms",
        {
          error: "sms_configuration_unavailable",
          reason: "sms_configuration_unavailable",
          requested_enabled: true,
          inspection: type,
        },
        type,
      );
      return res
        .status(400)
        .send("SMS 설정이 되어 있지 않습니다. 이메일/SMS 서비스에서 설정해 주세요.");
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const before = getInspectionSettings(type);
        const after = {
          sms: Object.hasOwn(body, "sms") ? body.sms : before.sms,
          smsRank: Object.hasOwn(body, "smsRank") ? body.smsRank : before.smsRank,
          cancelPenalty: Object.hasOwn(body, "cancelPenalty")
            ? body.cancelPenalty
            : before.cancelPenalty,
        };
        const update = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
        update.run(after.sms ? "TRUE" : "FALSE", inspectionSettingKey(type, "sms"));
        update.run(String(after.smsRank), inspectionSettingKey(type, "sms_rank"));
        update.run(String(after.cancelPenalty), inspectionSettingKey(type, "cancel_penalty"));
        return { before, after };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "settings.update",
        {
          error: result.internalError || result.error,
          inspection: type,
          requested: Object.fromEntries(fields.map((field) => [field, body[field]])),
        },
        type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "settings.update", result.result, type);
    res.json(result.result.after);
  });
}
