export function registerEventsRoutes({
  app,
  sseHandler,
  parseScoreYear,
  isScorePublished,
  handlePublicSSE,
}) {
  // SSE 엔드포인트
  app.get("/api/score/events", sseHandler());

  app.get("/api/score/public/:year/events", (req, res) => {
    const year = parseScoreYear(req.params.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
    handlePublicSSE(req, res);
  });
}
