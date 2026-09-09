export function registerEnduranceRoutes({
  app,
  db,
  logger,
  scoreTeamPreflight,
  dbRun,
  ENDURANCE_SQL,
  broadcastEvent,
}) {
  // GET /api/score/endurance?year=YYYY — 내구 기록 조회
  app.get("/api/score/endurance", (req, res) => {
    const year = Number(req.query.year);
    if (!year) return res.status(400).send("연도를 지정해야 합니다.");

    const rows = db
      .prepare(
        `
    SELECT e.* FROM score_endurance e
    WHERE e.year = ? AND NOT EXISTS (
      SELECT 1 FROM competition_inactive_team s
      WHERE s.year = e.year AND s.team_num = e.team_num
    )
  `,
      )
      .all(year);
    const result = {};
    for (const row of rows) {
      const {
        year: _year,
        team_num,
        energy_type: _legacyEnergyType,
        energy_dsq_reason: _legacyEnergyDsqReason,
        ...data
      } = row;
      result[team_num] = data;
    }
    res.json(result);
  });

  // PUT /api/score/endurance — 내구 기록 단일 필드 저장
  app.put("/api/score/endurance", (req, res) => {
    const { year, team_num, field, value } = req.body;
    if (!year || team_num == null || !field) {
      return res.status(400).send("필수 필드가 누락되었습니다.");
    }
    const numYear = Number(year);
    const numTeamNum = Number(team_num);
    if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099)
      return res.status(400).send("올바르지 않은 연도입니다.");
    if (!Number.isInteger(numTeamNum) || numTeamNum < 1)
      return res.status(400).send("올바르지 않은 팀 번호입니다.");
    const allowedFields = [
      "status",
      "driver1_name",
      "driver1_time",
      "driver1_start_delay",
      "driver1_cones",
      "driver1_oc",
      "driver1_penalty",
      "driver_change_time",
      "driver2_name",
      "driver2_time",
      "driver2_start_delay",
      "driver2_cones",
      "driver2_oc",
      "driver2_penalty",
      "fuel_consumed",
      "fuel_extra",
      "electric_net_energy",
      "energy_dsq",
      "qualified",
    ];
    if (!allowedFields.includes(field)) {
      return res.status(400).send("허용되지 않는 필드입니다.");
    }

    const textFields = new Set(["status", "driver1_name", "driver2_name"]);
    const trimmedText = textFields.has(field) && value != null ? String(value).trim() : null;
    const dbValue =
      value === null || value === "" || trimmedText === ""
        ? null
        : textFields.has(field)
          ? trimmedText
          : Number(value);
    if (field === "status" && dbValue !== null && !["DNS", "DNF", "DSQ"].includes(dbValue)) {
      return res.status(400).send("올바르지 않은 상태값입니다. (DNS, DNF, DSQ 또는 비움)");
    }
    if (
      ["driver1_name", "driver2_name"].includes(field) &&
      dbValue !== null &&
      dbValue.length > 100
    ) {
      return res.status(400).send("드라이버 이름은 100자 이하여야 합니다.");
    }
    if (!textFields.has(field) && dbValue !== null && !Number.isFinite(dbValue)) {
      return res.status(400).send("유효하지 않은 값입니다.");
    }
    if (["energy_dsq", "qualified"].includes(field) && ![0, 1].includes(dbValue)) {
      logger.warn(
        req,
        "endurance.update",
        {
          error: "invalid_toggle_value",
          reason: "invalid_toggle_value",
          year: numYear,
          field,
          requested: value,
        },
        `#${numTeamNum}`,
      );
      return res.status(400).send("토글 값은 0 또는 1이어야 합니다.");
    }
    if (
      !textFields.has(field) &&
      field !== "electric_net_energy" &&
      dbValue !== null &&
      dbValue < 0
    ) {
      return res.status(400).send("값은 음수일 수 없습니다.");
    }
    if (
      !scoreTeamPreflight(req, res, {
        action: "endurance.update",
        year: numYear,
        teamNum: numTeamNum,
        context: { field },
      })
    )
      return;

    let beforeValue = null;
    const result = dbRun(() => {
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO score_endurance (year, team_num) VALUES (?, ?)").run(
          numYear,
          numTeamNum,
        );
        beforeValue =
          db
            .prepare("SELECT * FROM score_endurance WHERE year = ? AND team_num = ?")
            .get(numYear, numTeamNum)?.[field] ?? null;
        db.prepare(ENDURANCE_SQL[field]).run(dbValue, numYear, numTeamNum);
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "endurance.update",
        {
          error: result.internalError || result.error,
          year: numYear,
          field,
          before: beforeValue,
          requested: dbValue,
        },
        `#${numTeamNum}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "endurance.update",
      { year: numYear, field, before: beforeValue, after: dbValue },
      `#${numTeamNum}`,
    );
    broadcastEvent("endurance", { year: numYear, team_num: numTeamNum, field, value: dbValue });

    res.status(200).send();
  });
}
