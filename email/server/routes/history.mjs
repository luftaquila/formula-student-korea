export function registerHistoryRoutes({
  app,
  dbRun,
  db,
  logger,
  getConfig,
  fetchFn,
  BREVO_API_BASE,
}) {
  /* ============================================
   Stats
   ============================================ */
  app.get("/api/stats", (req, res) => {
    const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const dayStart = new Date(`${kstDate}T00:00:00+09:00`);
    const start = dayStart.toISOString();
    const end = new Date(dayStart.getTime() + 86400000).toISOString();
    const result = dbRun(() => {
      const sent = db
        .prepare(
          "SELECT COUNT(*) as count FROM email_log WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?",
        )
        .get(start, end);
      const errors = db
        .prepare(
          "SELECT COUNT(*) as count FROM email_log WHERE status = 'error' AND sent_at >= ? AND sent_at < ?",
        )
        .get(start, end);
      const totalSent = db
        .prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'sent'")
        .get();
      const totalErrors = db
        .prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'error'")
        .get();
      return {
        sent: sent.count,
        errors: errors.count,
        totalSent: totalSent.count,
        totalErrors: totalErrors.count,
      };
    });

    if (!result.success) {
      logger.warn(req, "stats.query", { error: result.internalError || result.error });
      return res.status(result.status).send(result.error);
    }
    res.json(result.result);
  });

  /* ============================================
   Quota (Brevo API)
   ============================================ */
  app.get("/api/quota", async (req, res) => {
    const apiKey = getConfig("brevo_api_key");
    if (!apiKey) return res.json({ remaining: null, error: "API 키가 설정되지 않았습니다." });

    try {
      const resp = await fetchFn(`${BREVO_API_BASE}/account`, {
        headers: { "api-key": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        logger.warn(req, "email.quota_check", { error: text, status: resp.status });
        return res.json({ remaining: null, error: `Brevo API 오류 (${resp.status})` });
      }

      const data = await resp.json();
      const freePlan = data.plan?.find((p) => p.type === "free" && p.creditsType === "sendLimit");
      const remaining = freePlan?.credits ?? 0;
      res.json({ remaining });
    } catch (e) {
      logger.warn(req, "email.quota_check", { error: e.message });
      res.json({ remaining: null, error: "Brevo API 연결 실패" });
    }
  });

  /* ============================================
   Email Log
   ============================================ */
  app.get("/api/emails", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;

    const result = dbRun(() => {
      let query = `
      SELECT id, subject, recipient, status, error, message_id, source, sent_at, sent_by
      FROM email_log
    `;
      let countQuery = "SELECT COUNT(*) as total FROM email_log";
      const params = [];

      if (status && (status === "sent" || status === "error")) {
        query += " WHERE status = ?";
        countQuery += " WHERE status = ?";
        params.push(status);
      }

      query += " ORDER BY sent_at DESC LIMIT ? OFFSET ?";
      const total = db.prepare(countQuery).get(...params).total;
      const rows = db.prepare(query).all(...params, limit, offset);
      return { rows, total };
    });

    if (!result.success) {
      logger.warn(req, "email.list", { error: result.internalError || result.error });
      return res.status(result.status).send(result.error);
    }
    res.json(result.result);
  });

  app.get("/api/emails/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send("Invalid email id");

    const result = dbRun(() =>
      db
        .prepare(
          `
      SELECT id, subject, recipient, status, error, message_id, html_content, source, sent_at, sent_by
      FROM email_log
      WHERE id = ?
    `,
        )
        .get(id),
    );

    if (!result.success) {
      logger.warn(req, "email.get", { error: result.internalError || result.error }, String(id));
      return res.status(result.status).send(result.error);
    }
    if (!result.result) return res.status(404).send("Email not found");
    res.json(result.result);
  });
}
