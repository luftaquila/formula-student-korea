export function createEmailService({
  fetchFn,
  BREVO_API_BASE,
  logger,
  getConfig,
  dbRun,
  db,
  isInternalSecret,
}) {
  /* ============================================
   Brevo API Wrapper — single recipient, no side effects
   ============================================ */
  async function sendBrevo({ apiKey, senderName, senderEmail, subject, wrappedHtml, recipient }) {
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
        subject,
        htmlContent: wrappedHtml,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, messageId: data.messageId };
    return {
      ok: false,
      error: data.message || `Brevo API 오류 (${resp.status})`,
      status: resp.status >= 400 && resp.status < 500 ? 400 : 500,
    };
  }

  /* ============================================
   Shared Send Logic — config/quota, per-recipient loop, logging
   ============================================ */
  // Brevo 잔여 쿼터 캐시(60초). documents 예약 알림처럼 수신자별로 /api/internal/send를
  // 연속 호출하면 매 호출마다 /account 왕복이 발생하므로 짧게 캐시한다. 발송 성공 시
  // successCount만큼 차감해 60초 내 연속 발송에서도 잔여치가 과대평가되지 않게 한다.
  const QUOTA_CACHE_MS = 60000;

  let quotaCache = { apiKey: null, remaining: 0, fetchedAt: 0 };

  // 잔여 쿼터를 반환한다. 확인 실패는 non-fatal이므로 null을 반환하고 발송은 진행한다.
  async function getRemainingQuota(apiKey, req, { subject, source }) {
    const now = Date.now();
    if (quotaCache.apiKey === apiKey && now - quotaCache.fetchedAt < QUOTA_CACHE_MS) {
      return quotaCache.remaining;
    }
    try {
      const quotaResp = await fetchFn(`${BREVO_API_BASE}/account`, {
        headers: { "api-key": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!quotaResp.ok) {
        const quotaErrText = await quotaResp.text().catch(() => "");
        logger.warn(req, "email.quota_check", {
          error: quotaErrText || quotaResp.status,
          status: quotaResp.status,
          subject,
          source,
        });
        return null;
      }
      const quotaData = await quotaResp.json();
      const freePlan = quotaData.plan?.find(
        (p) => p.type === "free" && p.creditsType === "sendLimit",
      );
      const remaining = freePlan?.credits ?? 0;
      quotaCache = { apiKey, remaining, fetchedAt: now };
      return remaining;
    } catch (e) {
      logger.warn(req, "email.quota_check", { error: e.message, subject, source });
      return null;
    }
  }

  async function sendEmail(req, res, { subject, htmlContent, recipients, source }) {
    if (getConfig("email_enabled") === "FALSE") {
      logger.warn(req, "email.send", {
        error: "email_disabled",
        subject,
        recipientCount: recipients.length,
        source,
      });
      return res.status(503).send("이메일 전송이 비활성화되어 있습니다.");
    }

    const sentBy = req.user?.email || null;
    const apiKey = getConfig("brevo_api_key");
    const senderName = getConfig("brevo_sender_name");
    const senderEmail = getConfig("brevo_sender_email");

    if (!apiKey || !senderEmail) {
      logger.warn(req, "email.send", {
        error: "Brevo 설정 미완료",
        subject,
        recipientCount: recipients.length,
        source,
      });
      return res.status(400).send("Brevo API 키 또는 발신자 이메일이 설정되지 않았습니다.");
    }

    // Check quota before sending (60초 캐시, 확인 실패는 non-fatal)
    const remaining = await getRemainingQuota(apiKey, req, { subject, source });
    // 발송 후 차감이 어느 캐시 스냅샷을 기준으로 하는지 고정한다. 발송 중 다른 요청이
    // 새 /account fetch로 캐시를 갱신하면(fetchedAt 변경) 그 값은 이미 실제 잔여를
    // 반영하므로, 내 차감을 건너뛰어 이중 차감(→ 오탐 quota_exceeded)을 막는다.
    const quotaSnapshot = quotaCache.apiKey === apiKey ? quotaCache.fetchedAt : null;
    if (remaining != null && remaining < recipients.length) {
      logger.warn(req, "email.send", {
        error: "quota_exceeded",
        remaining,
        recipientCount: recipients.length,
        subject,
        source,
      });
      return res
        .status(400)
        .send(
          `전송 가능한 메일 수(${remaining}건)가 수신자 수(${recipients.length}명)보다 적습니다.`,
        );
    }

    const wrappedHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#333333;background-color:#ffffff;">
${htmlContent}
</body></html>`;

    // 수신자별 Brevo 호출을 소규모 동시성 풀로 처리한다. 대량 수동 발송에서 수신자 수만큼
    // 왕복이 직렬화되어 요청이 수 분간 열려 있던 것을 방지. DB 로그·집계는 원래 순서대로
    // 아래에서 일괄 수행해 기존 시맨틱(lastError = 마지막 수신자 순 오류)을 유지한다.
    const SEND_CONCURRENCY = 5;
    const results = new Array(recipients.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < recipients.length) {
        const i = nextIndex++;
        try {
          results[i] = await sendBrevo({
            apiKey,
            senderName,
            senderEmail,
            subject,
            wrappedHtml,
            recipient: recipients[i],
          });
        } catch (e) {
          results[i] = { ok: false, error: e.message, status: 500 };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, recipients.length) }, worker),
    );

    let successCount = 0;
    let lastMessageId = null;
    let lastError = null;
    let lastErrorStatus = 500;
    // 실패 수신자·사유 목록(뷰어 detail용, 10건 캡). 전수 기록은 email_log 테이블이 담당.
    const failedRecipients = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const result = results[i];

      // Per-recipient DB log
      if (result.ok) {
        const logResult = dbRun(() =>
          db
            .prepare(
              "INSERT INTO email_log (subject, recipient, status, message_id, html_content, source, sent_by, sent_at) VALUES (?, ?, 'sent', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            )
            .run(subject, recipient, result.messageId || null, htmlContent, source, sentBy),
        );
        if (!logResult.success)
          logger.warn(req, "email.log_insert", {
            error: logResult.internalError || logResult.error,
            subject,
            recipient,
            source,
          });
        successCount++;
        lastMessageId = result.messageId || lastMessageId;
      } else {
        const logResult = dbRun(() =>
          db
            .prepare(
              "INSERT INTO email_log (subject, recipient, status, error, html_content, source, sent_by, sent_at) VALUES (?, ?, 'error', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            )
            .run(subject, recipient, result.error, htmlContent, source, sentBy),
        );
        if (!logResult.success)
          logger.warn(req, "email.log_insert", {
            error: logResult.internalError || logResult.error,
            subject,
            recipient,
            source,
          });
        if (failedRecipients.length < 10) failedRecipients.push({ recipient, error: result.error });
        lastError = result.error;
        lastErrorStatus = result.status;
      }
    }

    // 발송분만큼 쿼터 캐시 차감 (60초 내 연속 발송 과대평가 방지). 단, 발송 중 캐시가
    // 새 fetch로 교체되지 않았을 때만 — 교체됐다면 그 값이 이미 실제 잔여를 반영하므로
    // 차감하면 이중 계산이 된다.
    if (quotaCache.apiKey === apiKey && quotaCache.fetchedAt === quotaSnapshot) {
      quotaCache.remaining = Math.max(0, quotaCache.remaining - successCount);
    }

    if (successCount === 0) {
      logger.warn(req, "email.send", {
        error: lastError || "전송 실패",
        subject,
        recipientCount: recipients.length,
        source,
      });
      return res.status(lastErrorStatus).send(lastError || "전송 실패");
    }

    if (successCount < recipients.length) {
      logger.warn(req, "email.send_partial", {
        subject,
        successCount,
        failedCount: recipients.length - successCount,
        failed: failedRecipients,
        lastError,
        source,
      });
    }
    // 내부 서비스에서 호출한 경우(예: documents 예약 알림은 수신자별 1건씩 호출), 호출자가
    // 자체 집계 로그(`schedule.*`)를 남기므로 성공 info는 생략해 로그 노이즈를 줄인다.
    // email_log 테이블에는 수신자별 행이 그대로 남아 추적 가능.
    const isInternal = isInternalSecret(req.headers["x-internal-service"]);
    if (!isInternal) {
      logger.log(req, "email.send", {
        subject,
        recipientCount: successCount,
        messageId: lastMessageId,
        source,
      });
    }
    res.json({ success: true, messageId: lastMessageId });
  }

  return { sendEmail };
}
