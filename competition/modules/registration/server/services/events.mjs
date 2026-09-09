import { createSSEManager } from "../../../../../shared/server/sse.mjs";
import {
  parseCompetitionYear,
  sendYearError,
} from "../../../../../shared/common/competition-year.mjs";

export function createRegistrationEvents({ logger, publicStatus }) {
  const { broadcast, handler: sseHandler, close: closeSse } = createSSEManager(200, { logger });

  function broadcastChange(year) {
    let status;
    try {
      status = publicStatus(year);
    } catch (error) {
      // A committed mutation must not be reported as failed only because its
      // follow-up public snapshot could not be computed. Clients still receive
      // an invalidation and recover the full status on reconnect.
      logger.warn(
        null,
        "registration.sse_broadcast",
        {
          error: error?.message || String(error),
          year,
        },
        String(year),
      );
      status = { year };
    }
    broadcast("registration", status, (meta) => meta.year === year);
  }

  function parseEventYear(req, res, next) {
    try {
      req.registrationYear = parseCompetitionYear(req.query.year);
      next();
    } catch (error) {
      sendYearError(res, error);
    }
  }

  function sourceEvent(event, data) {
    if (event !== "entries" || !data?.year) return;
    // 정식 팀이 바뀌면 열려 있는 화면이 로스터를 다시 받아야 한다. 대기열 변동
    // (registration)과 구분되는 이벤트로 알려, 큐가 움직일 때마다 로스터를
    // 재조회하지는 않게 한다.
    broadcast("entries", { year: data.year }, (meta) => meta.year === data.year);
    broadcastChange(data.year);
  }

  return { sseHandler, closeSse, broadcastChange, parseEventYear, sourceEvent };
}
