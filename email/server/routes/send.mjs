import { requireInternalRequest } from "../../../shared/server/express-setup.mjs";

export function registerSendRoutes({ app, logger, sendEmail }) {
  /* ============================================
   Send Email (Admin UI)
   ============================================ */
  app.post("/api/send", async (req, res) => {
    const { subject, htmlContent, recipients } = req.body;
    if (!subject || !htmlContent || !Array.isArray(recipients) || recipients.length === 0) {
      logger.warn(req, "email.send", { error: "필수값 누락 (제목/내용/수신자)" });
      return res.status(400).send("제목, 내용, 수신자가 필요합니다.");
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = recipients.filter((e) => !emailRegex.test(e));
    if (invalid.length > 0) {
      logger.warn(req, "email.send", { error: "잘못된 이메일 형식", invalid });
      return res.status(400).send(`유효하지 않은 이메일 주소: ${invalid.join(", ")}`);
    }

    await sendEmail(req, res, { subject, htmlContent, recipients, source: "manual" });
  });

  /* ============================================
   Internal Send API (for other services)
   ============================================ */
  app.post("/api/internal/send", async (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const { subject, htmlContent, recipients, source } = req.body;
    if (!subject || !htmlContent || !Array.isArray(recipients) || recipients.length === 0) {
      logger.warn(req, "email.send", {
        error: "필수값 누락 (subject/htmlContent/recipients)",
        source,
      });
      return res.status(400).send("subject, htmlContent, recipients are required.");
    }

    await sendEmail(req, res, { subject, htmlContent, recipients, source: source || "internal" });
  });
}
