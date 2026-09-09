export function registerPublicationRoutes({
  app,
  parseScoreYear,
  isScorePublished,
  dbRun,
  db,
  logger,
  publishedYears,
  invalidatePublicScoreCache,
  broadcastAdminEvent,
  broadcastPublicEvent,
  getPublicScorePayload,
  warnThrottled,
  publicScoreHtml,
}) {
  // GET /api/score/publication?year=YYYY — 관리자용 공개 상태 조회
  app.get("/api/score/publication", (req, res) => {
    const year = parseScoreYear(req.query.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    res.json({ year, enabled: isScorePublished(year) });
  });

  // PUT /api/score/publication — 관리자용 연도별 공개 상태 변경
  app.put("/api/score/publication", (req, res) => {
    const year = parseScoreYear(req.body.year);
    const { enabled } = req.body;
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    if (typeof enabled !== "boolean")
      return res.status(400).send("enabled는 boolean이어야 합니다.");

    const result = dbRun(() =>
      db
        .prepare(
          `
    INSERT INTO score_publication (year, enabled) VALUES (?, ?)
    ON CONFLICT(year) DO UPDATE SET enabled = excluded.enabled
  `,
        )
        .run(year, enabled ? 1 : 0),
    );

    if (!result.success) {
      logger.warn(
        req,
        "score_publication.update",
        { error: result.internalError || result.error, year, enabled },
        String(year),
      );
      return res.status(result.status).send(result.error);
    }

    if (enabled) publishedYears.add(year);
    else publishedYears.delete(year);
    invalidatePublicScoreCache(year);

    const payload = { year, enabled };
    logger.log(req, "score_publication.update", payload, String(year));
    broadcastAdminEvent("publication", payload);
    // 비공개 전환도 이미 접속한 공개 페이지에 전달해야 하므로 공개 여부 필터를 적용하지 않는다.
    broadcastPublicEvent("publication", payload, (meta) => meta.year === year);
    res.json(payload);
  });

  // GET /api/score/public/:year — 공개용 최소 데이터. 공개 중인 연도만 인증 없이 조회 가능하다.
  app.get("/api/score/public/:year", async (req, res) => {
    const year = parseScoreYear(req.params.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
    try {
      const payload = await getPublicScorePayload(year);
      // 집계 도중 공개가 꺼졌다면 응답 직전에 다시 차단한다.
      if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
      res.json(payload);
    } catch (e) {
      // 비인증 공개 라우트라 상류 장애 시 요청마다 로그가 폭주할 수 있어 throttle한다.
      warnThrottled("score.public_aggregate", { error: e.message, year });
      res.status(500).send("데이터 집계 오류가 발생했습니다.");
    }
  });

  app.get("/public/:year", (req, res, next) => {
    const year = parseScoreYear(req.params.year);
    if (year == null || !isScorePublished(year)) {
      return res.status(404).send("공개 중인 성적표가 아닙니다.");
    }
    publicScoreHtml(req, res, next);
  });
}
