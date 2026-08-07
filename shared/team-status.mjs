import { validateYear } from "./validation.mjs";

export function ensureTeamStatusTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_status (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (year, team_num)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_team_status_inactive ON team_status(year, active, team_num)");
}

// A missing snapshot means active for backwards compatibility and during rolling deploys.
export function isTeamActive(db, year, teamNum) {
  const row = db.prepare("SELECT active FROM team_status WHERE year = ? AND team_num = ?").get(year, teamNum);
  return row?.active !== 0;
}

// entry가 정합성 점검에서 읽는 스냅샷. 미러가 push로만 채워지므로, 전달 경로에 구멍이
// 나면(또는 이 서비스 DB가 백업에서 되돌아가면) 아무도 모르게 어긋난 채로 남는다.
// entry가 자기 진실과 대조할 수 있게 현재 상태를 그대로 노출한다.
export function registerTeamStatusSnapshotRoute(app, { db, dbRun, requireInternalRequest }) {
  app.get("/api/internal/team-status", (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const yearCheck = validateYear(req.query.year);
    if (!yearCheck.valid) return res.status(400).send("올바르지 않은 연도입니다.");

    const result = dbRun(() => db.prepare(
      "SELECT team_num, active, revision FROM team_status WHERE year = ?"
    ).all(yearCheck.value));
    if (!result.success) return res.status(result.status).send(result.error);

    const snapshot = {};
    for (const row of result.result) {
      snapshot[row.team_num] = { active: !!row.active, revision: row.revision };
    }
    res.json(snapshot);
  });
}

export function registerTeamStatusRoute(app, {
  db,
  dbRun,
  logger,
  requireInternalRequest,
  broadcastEvent,
  onDeactivate,
  onApplied,
}) {
  registerTeamStatusSnapshotRoute(app, { db, dbRun, requireInternalRequest });

  app.patch("/api/internal/team-active", (req, res) => {
    if (!requireInternalRequest(req, res)) return;

    const num = Number(req.body.num);
    const yearCheck = validateYear(req.body.year);
    const revision = Number(req.body.revision);
    if (!Number.isInteger(num) || num < 1 || !yearCheck.valid ||
        typeof req.body.active !== "boolean" || !Number.isInteger(revision) || revision < 0) {
      return res.status(400).send("올바르지 않은 엔트리 상태 요청입니다.");
    }
    const year = yearCheck.value;
    const active = req.body.active;

    const result = dbRun(() => db.transaction(() => {
      const current = db.prepare(
        "SELECT active, revision FROM team_status WHERE year = ? AND team_num = ?"
      ).get(year, num);
      if (current && current.revision >= revision) return { applied: false };

      db.prepare(`
        INSERT INTO team_status (year, team_num, active, revision) VALUES (?, ?, ?, ?)
        ON CONFLICT(year, team_num) DO UPDATE
        SET active = excluded.active, revision = excluded.revision
      `).run(year, num, active ? 1 : 0, revision);
      const deactivation = !active && onDeactivate ? onDeactivate({ db, year, num }) : undefined;
      return { applied: true, deactivation };
    })());

    if (!result.success) {
      logger.warn(req, "team.active", { error: result.error, year, active, revision }, `#${num}`);
      return res.status(result.status).send(result.error);
    }
    if (result.result.applied) {
      if (onApplied) onApplied({ year, num, active, revision, deactivation: result.result.deactivation });
      logger.log(req, "team.active", { year, active, revision }, `#${num}`);
      // 기존 행 mutation 채널(records/answer/manual-score 등)은 각기 다른 필수
      // payload 계약을 가진다. 상태 snapshot은 전용 이벤트로만 전달한다.
      broadcastEvent("team-active", { year, team_num: num, active, revision });
    }
    res.status(200).send();
  });
}
