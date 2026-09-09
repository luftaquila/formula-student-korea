export function registerSettingsRoutes({
  app,
  validateKey,
  scoreTeamPreflight,
  dbRun,
  db,
  logger,
  broadcastEvent,
}) {
  // PUT /api/score/manual — 수동 입력 점수 저장 (보고서, 가점, 감점)
  app.put("/api/score/manual", (req, res) => {
    const { year, team_num, score_type, value } = req.body;
    if (!year || team_num == null || !score_type) {
      return res.status(400).send("필수 필드가 누락되었습니다.");
    }
    const numYear = Number(year);
    const numTeamNum = Number(team_num);
    if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099)
      return res.status(400).send("올바르지 않은 연도입니다.");
    if (!Number.isInteger(numTeamNum) || numTeamNum < 1)
      return res.status(400).send("올바르지 않은 팀 번호입니다.");
    const keyErr = validateKey(score_type, "score_type");
    if (keyErr) return res.status(400).send(keyErr);
    if (score_type === "energy")
      return res.status(400).send("에너지 점수는 내구 계측값으로 자동 계산됩니다.");

    const numValue = value === null || value === "" ? null : Number(value);
    if (numValue !== null && !Number.isFinite(numValue))
      return res.status(400).send("유효하지 않은 값입니다.");
    if (
      !scoreTeamPreflight(req, res, {
        action: "manual_score.update",
        year: numYear,
        teamNum: numTeamNum,
        context: { score_type },
      })
    )
      return;
    if (score_type === "report" && numValue !== null) {
      if (numValue < 0) return res.status(400).send("보고서 점수는 음수일 수 없습니다.");
      const reportLimit = dbRun(
        () =>
          db
            .prepare(
              "SELECT value FROM score_setting WHERE year = ? AND event_type = '보고서' AND setting_key = 'total'",
            )
            .get(numYear)?.value,
      );
      if (!reportLimit.success) {
        logger.warn(
          req,
          "manual_score.update",
          {
            error: reportLimit.internalError || reportLimit.error,
            reason: reportLimit.internalError || reportLimit.error,
            phase: "report_limit_lookup",
            year: numYear,
            team_num: numTeamNum,
            score_type,
            requested_value: numValue,
          },
          `#${numTeamNum}`,
        );
        return res.status(500).send("보고서 점수 제한을 확인할 수 없습니다.");
      }
      const reportTotal = reportLimit.result;
      if (Number.isFinite(reportTotal) && numValue > reportTotal) {
        logger.warn(
          req,
          "manual_score.update",
          {
            error: "report_total_exceeded",
            reason: "report_total_exceeded",
            year: numYear,
            team_num: numTeamNum,
            score_type,
            requested_value: numValue,
            report_total: reportTotal,
          },
          `#${numTeamNum}`,
        );
        return res.status(400).send(`보고서 점수는 총점 ${reportTotal}점을 초과할 수 없습니다.`);
      }
    }

    const result = dbRun(() =>
      db
        .prepare(
          `INSERT INTO score_manual (year, team_num, score_type, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year, team_num, score_type)
         DO UPDATE SET value = excluded.value`,
        )
        .run(numYear, numTeamNum, score_type, numValue),
    );

    if (!result.success) {
      logger.warn(
        req,
        "manual_score.update",
        { error: result.internalError || result.error, year: numYear, score_type },
        `#${numTeamNum}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "manual_score.update",
      { year: numYear, score_type, value: numValue },
      `#${numTeamNum}`,
    );
    broadcastEvent("manual-score", {
      year: numYear,
      team_num: numTeamNum,
      score_type,
      value: numValue,
    });

    res.status(200).send();
  });

  // PUT /api/score/penalty — 경기 종목별 페널티 설정 저장
  app.put("/api/score/penalty", (req, res) => {
    const { year, event_type, cone_penalty, oc_penalty, start_delay } = req.body;
    if (!year || !event_type) {
      return res.status(400).send("필수 필드가 누락되었습니다.");
    }
    const numYear = Number(year);
    if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099)
      return res.status(400).send("올바르지 않은 연도입니다.");
    const keyErr = validateKey(event_type, "event_type");
    if (keyErr) return res.status(400).send(keyErr);

    const cone = cone_penalty == null ? 0 : Number(cone_penalty);
    const oc = oc_penalty == null ? 0 : Number(oc_penalty);
    const delay = start_delay == null ? 0 : Number(start_delay);

    if (!Number.isFinite(cone) || !Number.isFinite(oc) || !Number.isFinite(delay))
      return res.status(400).send("유효하지 않은 값입니다.");
    if (cone < 0 || oc < 0 || delay < 0)
      return res.status(400).send("페널티 값은 음수일 수 없습니다.");

    const result = dbRun(() =>
      db
        .prepare(
          `INSERT INTO score_penalty (year, event_type, cone_penalty, oc_penalty, start_delay)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(year, event_type)
         DO UPDATE SET cone_penalty = excluded.cone_penalty, oc_penalty = excluded.oc_penalty, start_delay = excluded.start_delay`,
        )
        .run(numYear, event_type, cone, oc, delay),
    );

    if (!result.success) {
      logger.warn(
        req,
        "penalty.update",
        { error: result.internalError || result.error, year: numYear },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "penalty.update", { year: numYear, cone: cone, oc: oc, delay }, event_type);
    broadcastEvent("penalty", {
      year: numYear,
      event_type,
      cone_penalty: cone,
      oc_penalty: oc,
      start_delay: delay,
    });

    res.status(200).send();
  });

  // PUT /api/score/setting — 경기 종목별 점수 설정 저장
  app.put("/api/score/setting", (req, res) => {
    const { year, event_type, setting_key, value } = req.body;
    if (!year || !event_type || !setting_key) {
      return res.status(400).send("필수 필드가 누락되었습니다.");
    }
    const numYear = Number(year);
    if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099)
      return res.status(400).send("올바르지 않은 연도입니다.");
    const etErr = validateKey(event_type, "event_type");
    if (etErr) return res.status(400).send(etErr);
    const skErr = validateKey(setting_key, "setting_key");
    if (skErr) return res.status(400).send(skErr);

    const numValue = value == null ? null : Number(value);

    if (numValue !== null && !Number.isFinite(numValue))
      return res.status(400).send("유효하지 않은 값입니다.");
    if (numValue !== null && numValue < 0)
      return res.status(400).send("설정 값은 음수일 수 없습니다.");

    const result = dbRun(() =>
      db
        .prepare(
          `INSERT INTO score_setting (year, event_type, setting_key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year, event_type, setting_key)
         DO UPDATE SET value = excluded.value`,
        )
        .run(numYear, event_type, setting_key, numValue),
    );

    if (!result.success) {
      logger.warn(
        req,
        "setting.update",
        { error: result.internalError || result.error, year: numYear, key: setting_key },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "setting.update",
      { year: numYear, key: setting_key, value: numValue },
      event_type,
    );
    broadcastEvent("setting", { year: numYear, event_type, setting_key, value: numValue });

    res.status(200).send();
  });
}
