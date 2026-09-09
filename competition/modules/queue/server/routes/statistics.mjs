import { competitionYearBounds } from "../../../../../shared/common/competition-year.mjs";
import { validateEntryNum } from "../../../../../shared/common/validation.mjs";

export function registerStatisticsRoutes({
  app,
  parseYearQuery,
  dbRun,
  db,
  validateInspection,
  requestTeamActivity,
}) {
  /* ============================================
   API 라우트: Admin - 통계
   ============================================ */

  // GET /api/admin/stats/timerange - 특정 연도의 로그 시간 범위 조회
  app.get("/api/admin/stats/timerange", (req, res) => {
    const year = parseYearQuery(req.query.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    const { from: yearStart, to: yearEnd } = competitionYearBounds(year);

    const result = dbRun(() => {
      const q = db
        .prepare(
          `SELECT MIN(timestamp) as minTs, MAX(timestamp) as maxTs FROM queue_log
       WHERE year = ? AND timestamp >= ? AND timestamp <= ?
         AND NOT EXISTS (
           SELECT 1 FROM competition_inactive_team s
           WHERE s.year = queue_log.year AND s.team_num = queue_log.num
         )`,
        )
        .get(year, yearStart, yearEnd);
      const b = db
        .prepare(
          `SELECT MIN(entered_at) as minTs, MAX(COALESCE(exited_at, entered_at)) as maxTs FROM booth_log
       WHERE year = ? AND entered_at >= ? AND entered_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM competition_inactive_team s
           WHERE s.year = booth_log.year AND s.team_num = booth_log.num
         )`,
        )
        .get(year, yearStart, yearEnd);

      const mins = [q?.minTs, b?.minTs].filter(Boolean);
      const maxs = [q?.maxTs, b?.maxTs].filter(Boolean);

      return {
        from: mins.length ? Math.min(...mins) : null,
        to: maxs.length ? Math.max(...maxs) : null,
      };
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/admin/stats - 전체 팀별 통계 조회
  app.get("/api/admin/stats", (req, res) => {
    const { from, to, inspection } = req.query;
    const year = parseYearQuery(req.query.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");

    if (inspection) {
      const typeValidation = validateInspection(inspection);
      if (!typeValidation.valid) {
        return res.status(400).send(typeValidation.error);
      }
    }

    const queueLogConditions = [
      "year = ?",
      `NOT EXISTS (
    SELECT 1 FROM competition_inactive_team s
    WHERE s.year = queue_log.year AND s.team_num = queue_log.num
  )`,
    ];
    const queueLogParams = [year];
    const boothLogConditions = [
      "year = ?",
      "exited_at IS NOT NULL",
      `NOT EXISTS (
    SELECT 1 FROM competition_inactive_team s
    WHERE s.year = booth_log.year AND s.team_num = booth_log.num
  )`,
    ];
    const boothLogParams = [year];

    if (from) {
      queueLogConditions.push("timestamp >= ?");
      queueLogParams.push(Number(from));
      boothLogConditions.push("entered_at >= ?");
      boothLogParams.push(Number(from));
    }
    if (to) {
      queueLogConditions.push("timestamp <= ?");
      queueLogParams.push(Number(to));
      boothLogConditions.push("exited_at <= ?");
      boothLogParams.push(Number(to));
    }
    if (inspection) {
      queueLogConditions.push("inspection = ?");
      queueLogParams.push(inspection);
      boothLogConditions.push("inspection = ?");
      boothLogParams.push(inspection);
    }

    const queueLogWhere = queueLogConditions.length
      ? `WHERE ${queueLogConditions.join(" AND ")}`
      : "";
    const boothLogWhere = `WHERE ${boothLogConditions.join(" AND ")}`;

    const result = dbRun(() => {
      const queueStats = db
        .prepare(
          `
      SELECT num,
        SUM(CASE WHEN event = 'register' THEN 1 ELSE 0 END) as registrations,
        SUM(CASE WHEN event = 'cancel' THEN 1 ELSE 0 END) as cancellations,
        SUM(CASE WHEN event = 'enter' THEN 1 ELSE 0 END) as entries
      FROM queue_log
      ${queueLogWhere}
      GROUP BY num
    `,
        )
        .all(...queueLogParams);

      const boothStats = db
        .prepare(
          `
      SELECT num, SUM(exited_at - entered_at) as totalOccupyTime
      FROM booth_log
      ${boothLogWhere}
      GROUP BY num
    `,
        )
        .all(...boothLogParams);

      const statsMap = new Map();
      for (const row of queueStats) {
        statsMap.set(row.num, {
          num: row.num,
          registrations: row.registrations,
          cancellations: row.cancellations,
          entries: row.entries,
          totalOccupyTime: 0,
        });
      }
      for (const row of boothStats) {
        if (statsMap.has(row.num)) {
          statsMap.get(row.num).totalOccupyTime = row.totalOccupyTime;
        } else {
          statsMap.set(row.num, {
            num: row.num,
            registrations: 0,
            cancellations: 0,
            entries: 0,
            totalOccupyTime: row.totalOccupyTime,
          });
        }
      }

      return Array.from(statsMap.values());
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/admin/stats/:num - 팀별 상세 통계 및 타임라인 조회
  app.get("/api/admin/stats/:num", (req, res) => {
    const numValidation = validateEntryNum(req.params.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const num = numValidation.value;
    const { from, to, inspection } = req.query;
    const year = parseYearQuery(req.query.year);
    if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
    const activity = requestTeamActivity(req, res, { action: "stats.view", num, year });
    if (!activity.ok) return;
    if (!activity.active) return res.status(404).send("엔트리를 찾을 수 없습니다.");

    if (inspection) {
      const typeValidation = validateInspection(inspection);
      if (!typeValidation.valid) {
        return res.status(400).send(typeValidation.error);
      }
    }

    const queueLogConditions = ["num = ?", "year = ?"];
    const queueLogParams = [num, year];
    const boothLogConditions = ["num = ?", "year = ?"];
    const boothLogParams = [num, year];
    const boothLogOccupyConditions = ["num = ?", "year = ?", "exited_at IS NOT NULL"];
    const boothLogOccupyParams = [num, year];

    // 타임라인용 boothLogConditions 는 구간과 "겹치는" 세션을 넉넉히 가져온다.
    // 입차/출차 이벤트는 각자 자기 타임스탬프(entered_at/exited_at)로 아래에서
    // 개별 필터링하므로, 여기서 exited_at 으로 행을 거르면 안 된다. 그렇게 하면
    // 검차중(exited_at IS NULL) 세션이 통째로 빠져 입차 이벤트가 출차 전까지
    // 숨겨지고, 출차 시 입차·출차가 동시에 나타나는 버그가 생긴다.
    if (from) {
      queueLogConditions.push("timestamp >= ?");
      queueLogParams.push(Number(from));
      // from 이전에 이미 종료된 세션만 제외(검차중 세션은 유지)
      boothLogConditions.push("(exited_at IS NULL OR exited_at >= ?)");
      boothLogParams.push(Number(from));
      boothLogOccupyConditions.push("entered_at >= ?");
      boothLogOccupyParams.push(Number(from));
    }
    if (to) {
      queueLogConditions.push("timestamp <= ?");
      queueLogParams.push(Number(to));
      // to 이후에 시작한 세션만 제외
      boothLogConditions.push("entered_at <= ?");
      boothLogParams.push(Number(to));
      boothLogOccupyConditions.push("exited_at <= ?");
      boothLogOccupyParams.push(Number(to));
    }
    if (inspection) {
      queueLogConditions.push("inspection = ?");
      queueLogParams.push(inspection);
      boothLogConditions.push("inspection = ?");
      boothLogParams.push(inspection);
      boothLogOccupyConditions.push("inspection = ?");
      boothLogOccupyParams.push(inspection);
    }

    const queueLogWhere = `WHERE ${queueLogConditions.join(" AND ")}`;
    const boothLogWhere = `WHERE ${boothLogConditions.join(" AND ")}`;
    const boothLogOccupyWhere = `WHERE ${boothLogOccupyConditions.join(" AND ")}`;

    const result = dbRun(() => {
      const queueSummary = db
        .prepare(
          `
      SELECT
        SUM(CASE WHEN event = 'register' THEN 1 ELSE 0 END) as registrations,
        SUM(CASE WHEN event = 'cancel' THEN 1 ELSE 0 END) as cancellations,
        SUM(CASE WHEN event = 'enter' THEN 1 ELSE 0 END) as entries
      FROM queue_log
      ${queueLogWhere}
    `,
        )
        .get(...queueLogParams);

      const occupyResult = db
        .prepare(
          `
      SELECT COALESCE(SUM(exited_at - entered_at), 0) as totalOccupyTime
      FROM booth_log
      ${boothLogOccupyWhere}
    `,
        )
        .get(...boothLogOccupyParams);

      // Register, cancel, and restore events from queue_log
      const queueEvents = db
        .prepare(
          `
      SELECT event, inspection, timestamp
      FROM queue_log
      ${queueLogWhere} AND event IN ('register', 'cancel', 'restore')
      ORDER BY timestamp ASC
    `,
        )
        .all(...queueLogParams)
        .map((row) => ({
          event: row.event,
          inspection: row.inspection,
          timestamp: row.timestamp,
        }));

      // Enter/exit events from booth_log
      const boothLogs = db
        .prepare(
          `
      SELECT inspection, booth_num as boothNum, entered_at as enteredAt, exited_at as exitedAt
      FROM booth_log
      ${boothLogWhere}
      ORDER BY entered_at ASC
    `,
        )
        .all(...boothLogParams);

      // 입차 이벤트는 entered_at, 출차 이벤트는 exited_at 기준으로 각각 구간에
      // 속하는지 개별 판단한다. 검차중(exited_at NULL) 세션도 입차가 즉시 노출된다.
      const fromTs = from ? Number(from) : null;
      const toTs = to ? Number(to) : null;
      const inRange = (ts) => (fromTs == null || ts >= fromTs) && (toTs == null || ts <= toTs);

      const boothEvents = [];
      for (const row of boothLogs) {
        if (inRange(row.enteredAt)) {
          boothEvents.push({
            event: "enter",
            inspection: row.inspection,
            boothNum: row.boothNum,
            timestamp: row.enteredAt,
          });
        }
        if (row.exitedAt && inRange(row.exitedAt)) {
          boothEvents.push({
            event: "exit",
            inspection: row.inspection,
            boothNum: row.boothNum,
            timestamp: row.exitedAt,
            duration: row.exitedAt - row.enteredAt,
          });
        }
      }

      const timeline = [...queueEvents, ...boothEvents].sort((a, b) => a.timestamp - b.timestamp);

      return {
        summary: {
          registrations: queueSummary.registrations || 0,
          cancellations: queueSummary.cancellations || 0,
          entries: queueSummary.entries || 0,
          totalOccupyTime: occupyResult.totalOccupyTime,
        },
        timeline,
      };
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });
}
