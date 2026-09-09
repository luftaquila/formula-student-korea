import { validateEntryNum } from "../../../../../shared/common/validation.mjs";

export function registerPublicRoutes({
  app,
  dbRun,
  getActiveInspections,
  rateLimit,
  getEntries,
  logger,
  currentYear,
  getCurrentEntry,
  getQueueRankRow,
  inspections,
  getQueueStmt,
  getQueueParams,
  db,
  validateInspection,
  getBoothsForType,
}) {
  /* ============================================
   API 라우트: Public
   ============================================ */

  // GET /api/active - 활성화된 검차 목록 조회
  app.get("/api/active", (req, res) => {
    const result = dbRun(() => getActiveInspections());

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/state/:num - 엔트리 번호로 모든 검차 대기 순번 조회
  app.get("/api/state/:num", rateLimit, async (req, res) => {
    const numValidation = validateEntryNum(req.params.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const num = numValidation.value;

    try {
      const entries = await getEntries();

      if (entries[num] === undefined) {
        return res.status(400).send("존재하지 않는 엔트리 번호입니다.");
      }
    } catch (e) {
      logger.warn(req, "queue.entry_lookup", { error: e.message, num });
      return res.status(500).send("엔트리를 조회할 수 없습니다.");
    }

    const year = currentYear();
    const result = dbRun(() => {
      const entry = getCurrentEntry(num, year);

      if (!entry) {
        return { year, queues: [] };
      }

      const queues = entry.inspections.flatMap((type) => {
        const ranked = getQueueRankRow(type, num, year);
        if (!ranked) return [];
        return [
          {
            type,
            name: inspections[type],
            isReinspection: ranked.is_reinspection === 1,
            rank: ranked.rank,
            total: ranked.total,
            groupRank: ranked.group_rank,
            groupTotal: ranked.group_total,
          },
        ];
      });
      return { year, queues };
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/public/queues - 활성 검차의 전체 공개 대기열
  app.get("/api/public/queues", async (req, res) => {
    const year = currentYear();
    let entries;
    try {
      entries = await getEntries();
    } catch (error) {
      logger.warn(req, "queue.public_queues", { error: error.message, year });
      return res.status(500).send("엔트리를 조회할 수 없습니다.");
    }

    const result = dbRun(() => ({
      year,
      queues: getActiveInspections(year)
        .filter((inspection) => !inspection.hidden_from_register)
        .map(({ type, name }) => {
          const ranked = getQueueStmt(type).all(...getQueueParams(type, year));
          return {
            type,
            name,
            total: ranked.length,
            firstInspectionTotal: ranked.filter((row) => row.is_reinspection === 0).length,
            reinspectionTotal: ranked.filter((row) => row.is_reinspection === 1).length,
            entries: ranked.map((row) => {
              const team = entries[row.num];
              if (!team)
                throw new Error(`canonical team missing for public queue entry ${row.num}`);
              return {
                teamId: team.id,
                number: row.num,
                university: team.univ,
                name: team.team,
                isReinspection: row.is_reinspection === 1,
                rank: row.rank,
                groupRank: row.group_rank,
                groupTotal: row.group_total,
              };
            }),
          };
        }),
    }));

    if (!result.success) {
      logger.warn(req, "queue.public_queues", {
        error: result.internalError || result.error,
        year,
      });
      return res.status(result.status).send(result.error);
    }
    return res.json(result.result);
  });

  // GET /api/booths/:type - 공개 부스 상태 조회
  app.get("/api/booths/all", (req, res) => {
    const result = dbRun(() => {
      // 타입별 개별 쿼리(N+1) 대신 단일 조회 후 그룹핑 (SSE init과 동일 패턴)
      const allBooths = {};
      for (const k of Object.keys(inspections)) allBooths[k] = [];
      for (const { inspection, ...row } of db
        .prepare(
          `
      SELECT inspection, booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms
      FROM booth ORDER BY inspection, booth_num
    `,
        )
        .all()) {
        if (allBooths[inspection]) allBooths[inspection].push(row);
      }
      return allBooths;
    });

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  app.get("/api/booths/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const result = dbRun(() => getBoothsForType(req.params.type));

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });
}
