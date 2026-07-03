// 팀 삭제/번호변경 라이프사이클 이벤트 소비자 라우트.
//
// entry가 durable outbox로 fan-out하는 `DELETE /api/internal/team/:num`,
// `PATCH /api/internal/team-num`를, num당 `(year, team_num)` 행을 보유하는 서비스가
// 동일하게 처리한다. tables(영향 테이블)와 channels(SSE 브로드캐스트 채널)만 주입하면
// 검증·self-renumber 가드·dbRun 트랜잭션·로깅·브로드캐스트가 일관되게 동작한다.
//
// 이전엔 inspection/score가 이 핸들러 쌍과 renumberTeamRows 헬퍼를 글자 단위로
// 복붙해 두고 있었다 — self-renumber 데이터 손실 가드/검증/로깅 계약을 양쪽에서
// 따로 고쳐야 했으므로 한 곳으로 모은다.
import { assertIdentifier } from "./db-setup.mjs";

// 목적지(newNum) 행을 먼저 지운 뒤 prevNum→newNum으로 갱신한다. prevNum 행이 없으면
// no-op이라 outbox 재전달에도 멱등하다(목적지 행을 건드리지 않음).
function renumberTeamRows(db, table, prevNum, newNum, year) {
  assertIdentifier(table);
  const existing = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE year = ? AND team_num = ?`).get(year, prevNum).count;
  if (existing === 0) return 0;
  db.prepare(`DELETE FROM ${table} WHERE year = ? AND team_num = ?`).run(year, newNum);
  return db.prepare(`UPDATE ${table} SET team_num = ? WHERE year = ? AND team_num = ?`).run(newNum, year, prevNum).changes;
}

export function registerTeamLifecycleRoutes(app, { db, dbRun, logger, requireInternalRequest, broadcastEvent, tables, channels }) {
  app.delete("/api/internal/team/:num", (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const num = Number(req.params.num);
    const year = Number(req.query.year);
    if (!Number.isInteger(num) || num < 1) {
      logger.warn(req, "team.cascade_delete", { error: "invalid team num", num: req.params.num });
      return res.status(400).send("올바르지 않은 팀 번호입니다.");
    }
    if (!Number.isInteger(year)) {
      logger.warn(req, "team.cascade_delete", { error: "invalid year", year: req.query.year }, `#${num}`);
      return res.status(400).send("연도를 지정해야 합니다.");
    }

    const result = dbRun(() => {
      db.transaction(() => {
        for (const table of tables) {
          assertIdentifier(table);
          db.prepare(`DELETE FROM ${table} WHERE year = ? AND team_num = ?`).run(year, num);
        }
      })();
    });

    if (!result.success) {
      logger.warn(req, "team.cascade_delete", { error: result.error, year }, `#${num}`);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "team.cascade_delete", { year }, `#${num}`);
    for (const channel of channels) broadcastEvent(channel, { year, team_num: num, deleted: true });
    res.status(200).send();
  });

  app.patch("/api/internal/team-num", (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const prevNum = Number(req.body.prevNum);
    const newNum = Number(req.body.newNum);
    const year = Number(req.body.year);
    if (!Number.isInteger(prevNum) || prevNum < 1 || !Number.isInteger(newNum) || newNum < 1 || !Number.isInteger(year)) {
      logger.warn(req, "team_num.update", { error: "invalid request", prevNum: req.body.prevNum, newNum: req.body.newNum, year: req.body.year });
      return res.status(400).send("올바르지 않은 요청입니다.");
    }
    // self-renumber는 helper가 목적지(=자기 번호) 행을 먼저 지운 뒤 갱신하므로 데이터 손실. 조기 반환.
    if (prevNum === newNum) return res.status(200).send();

    const result = dbRun(() => {
      db.transaction(() => {
        for (const table of tables) renumberTeamRows(db, table, prevNum, newNum, year);
      })();
    });

    if (!result.success) {
      logger.warn(req, "team_num.update", { error: result.error, year, prevNum, newNum });
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "team_num.update", { year, prevNum, newNum });
    for (const channel of channels) broadcastEvent(channel, { year, prevNum, team_num: newNum, renumbered: true });
    res.status(200).send();
  });
}
