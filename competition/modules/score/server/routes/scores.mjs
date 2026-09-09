export function registerScoresRoutes({ app, getComputedScore, logger }) {
  // GET /api/score?year=YYYY — 메인 집계 엔드포인트
  app.get("/api/score", async (req, res) => {
    const year = Number(req.query.year);
    if (!year) return res.status(400).send("연도를 지정해야 합니다.");
    try {
      res.json(await getComputedScore(year));
    } catch (e) {
      logger.warn(req, "score.aggregate", { error: e.message, year }, String(year));
      res.status(500).send("데이터 집계 오류가 발생했습니다.");
    }
  });
}
