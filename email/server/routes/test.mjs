import crypto from "node:crypto";
import { smsTestMessage } from "../../../shared/common/sms-template.mjs";
import { currentCompetitionYear } from "../../../shared/common/competition-year.mjs";
import https from "node:https";

export function registerTestRoutes({ app, logger, getConfig, fetchFn, BREVO_API_BASE }) {
  /* ============================================
   Test Email
   ============================================ */
  app.post("/api/test-email", async (req, res) => {
    const { recipient } = req.body;
    if (!recipient) {
      logger.warn(req, "email.test", { error: "recipient 누락" });
      return res.status(400).send("수신자 이메일이 필요합니다.");
    }

    if (getConfig("email_enabled") === "FALSE") {
      logger.warn(req, "email.test", { error: "email_disabled", recipient });
      return res.status(503).send("이메일 전송이 비활성화되어 있습니다.");
    }

    const apiKey = getConfig("brevo_api_key");
    const senderName = getConfig("brevo_sender_name");
    const senderEmail = getConfig("brevo_sender_email");

    if (!apiKey || !senderEmail) {
      logger.warn(req, "email.test", { error: "Brevo 설정 미완료", recipient });
      return res.status(400).send("Brevo API 키 또는 발신자 이메일이 설정되지 않았습니다.");
    }

    try {
      const resp = await fetchFn(`${BREVO_API_BASE}/smtp/email`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName || "FSK", email: senderEmail },
          to: [{ email: recipient }],
          subject: "[FSK] 이메일 전송 테스트",
          htmlContent: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#333333;background-color:#ffffff;">
<p>이 메일은 FSK 이메일 서비스의 테스트 메일입니다.</p>
</body></html>`,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const errorMsg = data.message || `Brevo API 오류 (${resp.status})`;
        logger.warn(req, "email.test", { error: errorMsg, recipient });
        return res.status(400).send(errorMsg);
      }

      logger.log(req, "email.test", { recipient, messageId: data.messageId });
      res.json({ success: true });
    } catch (e) {
      logger.warn(req, "email.test", { error: e.message, recipient });
      res.status(500).send("테스트 메일 전송 중 오류가 발생했습니다.");
    }
  });

  /* ============================================
   Test SMS
   ============================================ */
  app.post("/api/test-sms", async (req, res) => {
    const { recipient } = req.body;
    if (!recipient) {
      logger.warn(req, "sms.test", { error: "recipient 누락" });
      return res.status(400).send("수신자 전화번호가 필요합니다.");
    }

    const accessKey = getConfig("naver_cloud_access_key");
    const secretKey = getConfig("naver_cloud_secret_key");
    const serviceId = getConfig("naver_cloud_sms_service_id");
    const sender = getConfig("phone_number_sms_sender");

    if (!accessKey || !secretKey || !serviceId || !sender) {
      logger.warn(req, "sms.test", { error: "SMS 설정 미완료", recipient });
      return res.status(400).send("SMS 설정이 완료되지 않았습니다.");
    }

    const timestamp = String(Date.now());
    const path = `/sms/v2/services/${serviceId}/messages`;
    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(`POST ${path}\n${timestamp}\n${accessKey}`)
      .digest("base64");

    const body = JSON.stringify({
      type: "SMS",
      from: sender,
      content: smsTestMessage(currentCompetitionYear()),
      messages: [{ to: recipient }],
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const smsReq = https.request(
          {
            hostname: "sens.apigw.ntruss.com",
            port: 443,
            path,
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "x-ncp-apigw-timestamp": timestamp,
              "x-ncp-iam-access-key": accessKey,
              "x-ncp-apigw-signature-v2": signature,
            },
          },
          (smsRes) => {
            let data = "";
            smsRes.on("data", (chunk) => (data += chunk));
            smsRes.on("end", () => resolve({ status: smsRes.statusCode, data }));
          },
        );

        smsReq.setTimeout(10000, () => {
          smsReq.destroy();
          reject(new Error("SMS 전송 타임아웃"));
        });
        smsReq.on("error", reject);
        smsReq.write(body);
        smsReq.end();
      });

      if (result.status >= 200 && result.status < 300) {
        logger.log(req, "sms.test", { recipient, response: result.data });
        res.json({ success: true });
      } else {
        logger.warn(req, "sms.test", { error: result.data, recipient, status: result.status });
        res.status(400).send(`SMS 전송 실패 (${result.status}): ${result.data}`);
      }
    } catch (e) {
      logger.warn(req, "sms.test", { error: e.message, recipient });
      res.status(500).send("테스트 SMS 전송 중 오류가 발생했습니다.");
    }
  });
}
