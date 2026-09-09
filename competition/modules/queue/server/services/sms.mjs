import {
  createSmsClient,
  createThrottledSkipWarning,
} from "../../../../../shared/server/sms-client.mjs";
import { inspectionQueueRankSms } from "../../../../../shared/common/sms-template.mjs";
import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function createQueueSms({
  logger,
  options,
  getInspectionSettings,
  currentYear,
  getQueueStmt,
  getQueueParams,
  inspections,
}) {
  // Competition 은 이 클라이언트를 Registration 에도 넘겨 한 프로세스가 SENS 자격
  // 증명 한 벌과 갱신 타이머 하나만 갖도록 한다(createRegistrationApp options.smsClient).
  const smsClient = createSmsClient({
    logger,
    smsRequest: options.smsRequest,
    smsConfig: options.smsConfig,
    fetchImpl: options.fetchImpl,
  });

  const loadSmsConfig = smsClient.loadConfig;

  // SMS 켜져 있는데 설정을 못 쓰는 상태의 skip 경고(60초 스로틀) — 발송마다 쌓이지 않게.
  // Registration 의 registration.sms_skip 과 같은 규칙을 공유한다.
  const warnSmsSkipThrottled = createThrottledSkipWarning(logger, "sms.skip");

  function sendSmsNotification(type, prev) {
    let target;
    try {
      const settings = getInspectionSettings(type);
      if (!settings?.sms) return;

      const year = currentYear();
      const smsRank = settings.smsRank;
      target = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);

      if (target && (!prev || target.num !== prev.num)) {
        if (!smsClient.isAvailable()) {
          warnSmsSkipThrottled({
            reason: "SMS 설정을 사용할 수 없습니다(email 서비스 미응답 또는 설정 미완성)",
            num: target.num,
            type,
          });
          return;
        }
        smsClient
          .send(
            target.phone,
            inspectionQueueRankSms({
              year: currentCompetitionYear(),
              num: target.num,
              inspection: inspections[type],
              rank: smsRank,
            }),
          )
          .then(
            ({ response, status }) =>
              logger.log(null, "sms.send", {
                response,
                status,
                num: target.num,
                type,
              }),
            // 성공/실패 모두 sms.send로 묶고 세부 원인은 code/status로 구분한다. 로그
            // 뷰어의 액션 필터 하나로 전체 발송 시도를 조회할 수 있어야 한다.
            (error) =>
              logger.warn(null, "sms.send", {
                error: error?.response || error?.message || String(error),
                code: error?.code,
                status: error?.status,
                num: target.num,
                type,
              }),
          );
      }
    } catch (e) {
      logger.warn(null, "sms.send", { error: String(e), num: target?.num, type });
    }
  }

  return { smsClient, loadSmsConfig, sendSmsNotification };
}
