import { createThrottledSkipWarning } from "../../../../../shared/server/sms-client.mjs";
import { registrationQueueRankSms } from "../../../../../shared/common/sms-template.mjs";

export function createRegistrationSms({
  smsClient,
  logger,
  dbRun,
  db,
  auditTeam,
  settingsForYear,
  advanceTarget,
}) {
  const pendingTasks = new Set();

  const track = (promise) => {
    pendingTasks.add(promise);
    promise.then(
      () => pendingTasks.delete(promise),
      () => pendingTasks.delete(promise),
    );
    return promise;
  };

  function finishAdvanceNotification(id, team, sent, claimToken) {
    const result = dbRun(() =>
      db
        .prepare(
          `
      UPDATE registration_queue
      SET notified = ?, notify_claimed_at = NULL
      WHERE id = ? AND notified = 2 AND notify_claimed_at = ?
    `,
        )
        .run(sent ? 1 : 0, id, claimToken),
    );
    if (!result.success) {
      logger.warn(
        null,
        "registration.sms_claim",
        {
          error: result.internalError || result.error,
          registrationId: id,
          team: auditTeam(team),
          sent,
        },
        String(id),
      );
    }
  }

  // Queue 의 sms.skip 과 같은 스로틀 규칙. 사전 안내 자체는 두 모듈이 따로 구현한다 —
  // 대기열 모양이 다르고(검차는 종목별, 등록은 연도별) 등록만 선점(claim) 프로토콜을
  // 쓴다. 순번 규칙을 바꿀 때는 양쪽을 함께 봐야 한다.
  const warnSmsSkip = createThrottledSkipWarning(logger, "registration.sms_skip");

  function warnSmsUnavailable(year) {
    warnSmsSkip({ reason: "sms_configuration_unavailable", year }, String(year));
  }

  function dispatchSms({ kind, team, registrationId, phone, content, onSuccess, onFailure }) {
    const task = Promise.resolve()
      .then(() => smsClient.send(phone, content))
      .then(
        ({ response, status }) => {
          onSuccess?.();
          logger.log(
            null,
            "registration.sms_send",
            {
              kind,
              registrationId,
              team: auditTeam(team),
              status,
              response,
            },
            String(registrationId),
          );
        },
        (error) => {
          onFailure?.();
          logger.warn(
            null,
            "registration.sms_send",
            {
              kind,
              registrationId,
              team: auditTeam(team),
              error: error?.response || error?.message || String(error),
              status: error?.status,
            },
            String(registrationId),
          );
        },
      );
    track(task);
  }

  function notifyUpcoming(year, previousTargetId) {
    try {
      const settings = settingsForYear(year);
      if (!settings.sms || settings.notifyRank <= 0) return;
      if (!smsClient.isAvailable()) {
        warnSmsUnavailable(year);
        return;
      }

      const target = advanceTarget(year, settings.notifyRank);
      if (!target || target.id === previousTargetId || target.notified === 1) return;

      const claimToken = new Date().toISOString();
      const claim = dbRun(() =>
        db
          .prepare(
            `
        UPDATE registration_queue
        SET notified = 2, notify_claimed_at = ?
        WHERE id = ? AND status = 'waiting'
          AND (notified = 0 OR (
            notified = 2 AND (
              notify_claimed_at IS NULL
              OR notify_claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')
            )
          ))
      `,
          )
          .run(claimToken, target.id),
      );
      if (!claim.success) {
        logger.warn(
          null,
          "registration.sms_claim",
          {
            error: claim.internalError || claim.error,
            registrationId: target.id,
            teamId: target.team_id,
          },
          String(target.id),
        );
        return;
      }
      if (claim.result.changes !== 1) return;

      const team = {
        id: target.team_id,
        year: target.year,
        number: target.num,
        university: target.univ,
        name: target.name,
        active: target.active === 1,
      };
      dispatchSms({
        kind: "advance",
        team,
        registrationId: target.id,
        phone: target.phone,
        content: registrationQueueRankSms({
          year,
          num: target.num,
          rank: settings.notifyRank,
        }),
        onSuccess: () => finishAdvanceNotification(target.id, team, true, claimToken),
        onFailure: () => finishAdvanceNotification(target.id, team, false, claimToken),
      });
    } catch (error) {
      logger.warn(
        null,
        "registration.sms_prepare",
        {
          error: error?.message || String(error),
          year,
        },
        String(year),
      );
    }
  }

  return { pendingTasks, notifyUpcoming };
}
