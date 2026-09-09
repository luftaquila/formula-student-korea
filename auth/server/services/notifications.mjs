import { serviceUrl } from "../../../shared/server/services.mjs";

export function createNotificationService({ logger }) {
  const EMAIL_SERVER = serviceUrl("email");

  async function notifyNewUser(emails) {
    if (!process.env.INTERNAL_SECRET) return;
    try {
      const list = Array.isArray(emails) ? emails : [emails];
      const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
      const r = await fetch(`${EMAIL_SERVER}/api/internal/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Service": process.env.INTERNAL_SECRET,
        },
        body: JSON.stringify({
          subject: "[FSK] 계정 등록 완료",
          htmlContent:
            `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea Service Hub 계정이 등록되었습니다.</h2>` +
            `<p style="margin:0;font-size:14px;line-height:1.6">Google 계정으로 <a href="${url}">FSK Service Hub</a>에 로그인하여 서비스를 이용하세요.</p>`,
          recipients: list,
          source: "auth",
        }),
        signal: AbortSignal.timeout(5000),
      });
      // 네트워크 예외만 잡으면 email 서비스의 4xx/5xx 거절이 무기록으로 유실된다.
      if (!r.ok) logger.warn(null, "email.notify", { error: `email service ${r.status}`, emails });
    } catch (e) {
      logger.warn(null, "email.notify", { error: e.message, emails });
    }
  }

  return { notifyNewUser };
}
