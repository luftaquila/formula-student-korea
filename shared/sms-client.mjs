import crypto from "node:crypto";
import https from "node:https";
import { serviceUrl } from "./services.mjs";

const CONFIG_KEYS = Object.freeze([
  "naver_cloud_access_key",
  "naver_cloud_secret_key",
  "naver_cloud_sms_service_id",
  "phone_number_sms_sender",
]);

function completeConfig(value) {
  return value && CONFIG_KEYS.every((key) => typeof value[key] === "string" && value[key]);
}

function smsError(message, { status, response, code = "SMS_SEND_FAILED" } = {}) {
  return Object.assign(new Error(message), {
    code,
    ...(status == null ? {} : { status }),
    ...(response == null ? {} : { response }),
  });
}

/**
 * Competition 모듈이 공통으로 사용하는 Naver SENS 클라이언트.
 *
 * Email 서비스는 자격 증명의 단일 소스이고, 이 객체는 성공적으로 읽은 설정을 메모리에
 * 보관한다. 일시적인 fetch 실패에는 마지막 정상 설정을 유지하지만, Email 서비스가 200으로
 * 불완전한 설정을 반환하면 관리자가 설정을 지운 확정 상태이므로 즉시 비운다.
 */
export function createSmsClient({
  logger,
  smsRequest = https.request,
  smsConfig = null,
  fetchImpl = globalThis.fetch,
  refreshMs = 5 * 60 * 1000,
  requestTimeoutMs = 5000,
} = {}) {
  let config = completeConfig(smsConfig) ? { ...smsConfig } : null;

  async function loadConfig({ retries = 0, delayMs = 3000 } = {}) {
    if (!process.env.INTERNAL_SECRET) return false;
    const url = `${serviceUrl("email")}/api/internal/sms-config`;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(url, {
          headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          logger?.warn(null, "sms.config_fetch", { status: response.status });
          return false;
        }
        const next = await response.json();
        config = completeConfig(next) ? { ...next } : null;
        return !!config;
      } catch (error) {
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        logger?.warn(null, "sms.config_fetch", { error: error?.message || String(error) });
        return false;
      }
    }
  }

  function isAvailable() {
    return !!config;
  }

  function send(to, content) {
    if (!config) {
      return Promise.reject(smsError("SMS 설정을 사용할 수 없습니다.", {
        code: "SMS_CONFIGURATION_UNAVAILABLE",
      }));
    }

    const path = `/sms/v2/services/${config.naver_cloud_sms_service_id}/messages`;
    const timestamp = String(Date.now());
    const signature = crypto
      .createHmac("sha256", config.naver_cloud_secret_key)
      .update(`POST ${path}\n${timestamp}\n${config.naver_cloud_access_key}`)
      .digest("base64");
    const body = JSON.stringify({
      type: "SMS",
      from: config.phone_number_sms_sender,
      content,
      messages: [{ to }],
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const request = smsRequest({
        hostname: "sens.apigw.ntruss.com",
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-ncp-apigw-timestamp": timestamp,
          "x-ncp-iam-access-key": config.naver_cloud_access_key,
          "x-ncp-apigw-signature-v2": signature,
        },
      }, (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            finish(resolve, { status: response.statusCode, response: data });
          } else {
            finish(reject, smsError(`SENS ${response.statusCode}`, {
              status: response.statusCode,
              response: data,
            }));
          }
        });
        response.on("aborted", () => finish(reject, smsError("SMS 응답이 중단되었습니다.")));
        response.on("error", (error) => finish(reject, smsError(error?.message || String(error))));
        response.on("close", () => {
          if (!settled) finish(reject, smsError("SMS 응답이 완료되기 전에 종료되었습니다."));
        });
      });

      request.setTimeout?.(requestTimeoutMs, () => {
        finish(reject, smsError("SMS 요청 타임아웃", { code: "SMS_TIMEOUT" }));
        request.destroy?.();
      });
      request.on?.("error", (error) => finish(reject, smsError(error?.message || String(error))));
      request.write(body);
      request.end();
    });
  }

  const refreshTimer = setInterval(loadConfig, refreshMs);
  refreshTimer.unref();

  return { loadConfig, isAvailable, send, timer: refreshTimer };
}
