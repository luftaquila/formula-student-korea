import { validateEntryNum } from "../../../../../shared/common/validation.mjs";

export function registerBoothsRoutes({
  app,
  validateInspection,
  dbRun,
  getBoothsForType,
  db,
  logger,
  broadcastEvent,
  currentYear,
  requestTeamActivity,
  getInspectionSettings,
  getQueueStmt,
  getQueueParams,
  getQueueRow,
  deleteQueueRow,
  getCurrentEntry,
  setCurrentInspections,
  broadcastBooth,
  broadcastQueue,
  sendSmsNotification,
  options,
  tableColumns,
}) {
  // GET /api/admin/booths/:type - 검차별 부스 목록 조회
  app.get("/api/admin/booths/:type", (req, res) => {
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

  // PATCH /api/admin/booths/:type/config - 부스 수 변경
  app.patch("/api/admin/booths/:type/config", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const count = parseInt(req.body.count, 10);

    if (isNaN(count) || count < 1 || count > 100) {
      return res.status(400).send("부스 수는 1~100 사이여야 합니다.");
    }

    const result = dbRun(() => {
      return db.transaction(() => {
        const config = db.prepare("SELECT count FROM booth_config WHERE inspection = ?").get(type);
        if (!config) throw { status: 400, message: "부스 설정을 찾을 수 없습니다." };
        const currentCount = config.count;

        if (count > currentCount) {
          // 부스 추가
          for (let i = currentCount + 1; i <= count; i++) {
            db.prepare("INSERT INTO booth (inspection, booth_num) VALUES (?, ?)").run(type, i);
          }
        } else if (count < currentCount) {
          // 부스 삭제 (높은 번호부터, 점유 중인 부스는 삭제 불가)
          const boothsToRemove = db
            .prepare(
              "SELECT booth_num, occupied_by FROM booth WHERE inspection = ? ORDER BY booth_num DESC LIMIT ?",
            )
            .all(type, currentCount - count);

          for (const booth of boothsToRemove) {
            if (booth.occupied_by !== null) {
              throw {
                status: 400,
                message: `부스 ${booth.booth_num}번이 사용 중이므로 삭제할 수 없습니다.`,
              };
            }
          }

          for (const booth of boothsToRemove) {
            db.prepare("DELETE FROM booth WHERE inspection = ? AND booth_num = ?").run(
              type,
              booth.booth_num,
            );
          }
        }

        db.prepare("UPDATE booth_config SET count = ? WHERE inspection = ?").run(count, type);
      })();
    });

    if (!result.success) {
      logger.warn(req, "booth.count", { error: result.internalError || result.error }, type);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "booth.count", { count }, type);

    // SSE 브로드캐스트: 부스 상태 변경
    const booths = getBoothsForType(type);
    broadcastEvent("booth", { type, booths });

    res.status(200).send();
  });

  // PATCH /api/admin/booths/:type/:boothNum - 부스 활성화/비활성화 토글
  app.patch("/api/admin/booths/:type/:boothNum", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const boothNum = parseInt(req.params.boothNum, 10);

    if (isNaN(boothNum) || boothNum < 1) {
      return res.status(400).send("올바르지 않은 부스 번호입니다.");
    }

    const result = dbRun(() => {
      const booth = db
        .prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?")
        .get(type, boothNum);

      if (!booth) {
        throw { status: 400, message: "존재하지 않는 부스입니다." };
      }

      if (req.body.active === false && booth.occupied_by !== null) {
        throw { status: 400, message: "사용 중인 부스는 비활성화할 수 없습니다." };
      }

      db.prepare("UPDATE booth SET active = ? WHERE inspection = ? AND booth_num = ?").run(
        req.body.active === true ? 1 : 0,
        type,
        boothNum,
      );
    });

    if (!result.success) {
      logger.warn(
        req,
        "booth.toggle",
        {
          error: result.internalError || result.error,
          booth: boothNum,
          active: req.body.active === true,
        },
        type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "booth.toggle", { booth: boothNum, active: req.body.active === true }, type);

    // SSE 브로드캐스트: 부스 상태 변경
    const booths = getBoothsForType(type);
    broadcastEvent("booth", { type, booths });

    res.status(200).send();
  });

  // POST /api/admin/booths/:type/:boothNum/enter - 대기열에서 부스로 입장
  app.post("/api/admin/booths/:type/:boothNum/enter", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.body.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const type = typeValidation.value;
    const num = numValidation.value;
    const boothNum = parseInt(req.params.boothNum, 10);

    if (isNaN(boothNum) || boothNum < 1) {
      return res.status(400).send("올바르지 않은 부스 번호입니다.");
    }

    const year = currentYear();

    const activity = requestTeamActivity(req, res, { action: "booth.enter", num, year });
    if (!activity.ok) return;
    if (!activity.active) {
      logger.warn(
        req,
        "booth.enter",
        {
          error: "inactive_or_missing_team",
          reason: "inactive_or_missing_team",
          year,
          team_num: num,
          inspection: type,
          booth: boothNum,
        },
        `#${num}`,
      );
      return res.status(409).send("비활성화된 엔트리는 부스에 입장시킬 수 없습니다.");
    }

    const result = dbRun(() => {
      return db.transaction(() => {
        const smsRank = getInspectionSettings(type).smsRank;
        const prev = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);
        // 대기열에 팀이 있는지 확인
        const queueEntry = getQueueRow(type, num, year);
        if (!queueEntry) {
          throw { status: 400, message: "대기열에 존재하지 않는 엔트리입니다." };
        }

        // 부스 확인
        const booth = db
          .prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?")
          .get(type, boothNum);
        if (!booth) {
          throw { status: 400, message: "존재하지 않는 부스입니다." };
        }
        if (!booth.active) {
          throw { status: 400, message: "비활성화된 부스입니다." };
        }
        if (booth.occupied_by !== null) {
          throw { status: 400, message: "이미 사용 중인 부스입니다." };
        }

        const now = Date.now();

        // 대기열에서 제거 및 길이 감소
        deleteQueueRow(type, num, year);

        // 부스 점유
        db.prepare(
          `
        UPDATE booth
        SET occupied_by = ?, occupied_team_id = ?, entered_at = ?,
            timer_paused_at = NULL, timer_paused_ms = 0
        WHERE inspection = ? AND booth_num = ?
      `,
        ).run(num, activity.team?.id ?? null, now, type, boothNum);

        // 부스 로그 기록
        db.prepare(
          "INSERT INTO booth_log (num, inspection, booth_num, entered_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(num, type, boothNum, now, now, year);

        // 대기열 이벤트 로그 기록
        db.prepare(
          "INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)",
        ).run("enter", num, type, now, year);

        // current 테이블에서 해당 검차 종류 제거
        const current = getCurrentEntry(num, year);
        if (current) {
          const remaining = current.inspections.filter((i) => i !== type);
          setCurrentInspections(num, current.phone, remaining, year);
        }
        return { prev };
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "booth.enter",
        {
          error: result.internalError || result.error,
          phase: "mutation_preflight",
          year,
          team_num: num,
          inspection: type,
          booth: boothNum,
        },
        `#${num}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "booth.enter",
      {
        inspection: type,
        booth: boothNum,
        year,
        team_id: activity.team?.id ?? null,
      },
      `#${num}`,
    );

    // SSE 브로드캐스트: 부스 및 대기열 변경
    broadcastBooth(type);
    broadcastQueue(type);

    res.status(200).send();

    // SMS 발송 (N번째 대기자에게)
    sendSmsNotification(type, result.result.prev);
  });

  // PATCH /api/admin/booths/:type/:boothNum/timer - 검차 진행 표시 타이머 중단/재개
  app.patch("/api/admin/booths/:type/:boothNum/timer", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const boothNum = parseInt(req.params.boothNum, 10);
    const paused = req.body.paused;

    if (isNaN(boothNum) || boothNum < 1) {
      return res.status(400).send("올바르지 않은 부스 번호입니다.");
    }
    if (typeof paused !== "boolean") {
      return res.status(400).send("타이머 상태가 올바르지 않습니다.");
    }

    let boothBefore = null;
    const result = dbRun(() => {
      const booth = db
        .prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?")
        .get(type, boothNum);
      if (!booth) {
        throw { status: 400, message: "존재하지 않는 부스입니다." };
      }
      if (booth.occupied_by === null) {
        throw { status: 400, message: "비어있는 부스의 타이머는 변경할 수 없습니다." };
      }

      const pausedAt = booth.timer_paused_at == null ? null : Number(booth.timer_paused_at);
      const pausedMs = Math.max(0, Number(booth.timer_paused_ms) || 0);
      boothBefore = {
        occupied_by: booth.occupied_by,
        entered_at: booth.entered_at,
        timer_paused_at: pausedAt,
        timer_paused_ms: pausedMs,
      };

      const now = Date.now();
      if (paused) {
        if (pausedAt !== null) {
          throw { status: 409, message: "타이머가 이미 중단되어 있습니다." };
        }
        db.prepare(
          `
        UPDATE booth SET timer_paused_at = ?
        WHERE inspection = ? AND booth_num = ?
      `,
        ).run(now, type, boothNum);
      } else {
        if (pausedAt === null) {
          throw { status: 409, message: "타이머가 이미 진행 중입니다." };
        }
        db.prepare(
          `
        UPDATE booth SET timer_paused_at = NULL, timer_paused_ms = ?
        WHERE inspection = ? AND booth_num = ?
      `,
        ).run(pausedMs + Math.max(0, now - pausedAt), type, boothNum);
      }

      return getBoothsForType(type).find((item) => item.booth_num === boothNum);
    });

    if (!result.success) {
      logger.warn(
        req,
        paused ? "booth.timer.pause" : "booth.timer.resume",
        {
          error: result.internalError || result.error,
          inspection: type,
          booth: boothNum,
          before: boothBefore,
        },
        type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      paused ? "booth.timer.pause" : "booth.timer.resume",
      {
        inspection: type,
        booth: boothNum,
        before: boothBefore,
        after: result.result,
      },
      `#${result.result.occupied_by}`,
    );

    broadcastBooth(type);
    res.json(result.result);
  });

  // POST /api/admin/booths/:type/:boothNum/exit - 부스에서 퇴장 (검차 완료)
  app.post("/api/admin/booths/:type/:boothNum/exit", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const boothNum = parseInt(req.params.boothNum, 10);

    if (isNaN(boothNum) || boothNum < 1) {
      return res.status(400).send("올바르지 않은 부스 번호입니다.");
    }

    let boothBefore = null;
    const result = dbRun(() =>
      db.transaction(() => {
        const booth = db
          .prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?")
          .get(type, boothNum);
        if (!booth) {
          throw { status: 400, message: "존재하지 않는 부스입니다." };
        }
        if (booth.occupied_by === null) {
          throw { status: 400, message: "비어있는 부스입니다." };
        }
        boothBefore = {
          occupied_by: booth.occupied_by,
          occupied_team_id: booth.occupied_team_id ?? null,
          entered_at: booth.entered_at ?? null,
          timer_paused_at: booth.timer_paused_at ?? null,
          timer_paused_ms: booth.timer_paused_ms ?? 0,
        };

        const now = Date.now();
        const current = currentYear();
        const persistedTeamId = Number(booth.occupied_team_id);
        const hasPersistedTeamId = Number.isInteger(persistedTeamId) && persistedTeamId > 0;
        const canonical =
          hasPersistedTeamId && options.teamStore?.getById
            ? options.teamStore.getById(persistedTeamId)
            : null;
        if (
          hasPersistedTeamId &&
          options.teamStore?.getById &&
          (!canonical || canonical.number !== booth.occupied_by)
        ) {
          throw { status: 409, message: "부스의 팀 정보가 일치하지 않습니다." };
        }
        const num = canonical?.number ?? booth.occupied_by;
        const stateYear = canonical?.year ?? current;
        const historicalState = stateYear !== current;
        const logHasTeamId = tableColumns(db, "booth_log").has("team_id");
        let logMutation;
        if (logHasTeamId && hasPersistedTeamId) {
          logMutation = historicalState
            ? db
                .prepare(
                  `
              DELETE FROM booth_log
              WHERE team_id = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `,
                )
                .run(persistedTeamId, type, boothNum, stateYear)
            : db
                .prepare(
                  `
              UPDATE booth_log SET exited_at = ?
              WHERE team_id = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `,
                )
                .run(now, persistedTeamId, type, boothNum, stateYear);
        } else {
          logMutation = historicalState
            ? db
                .prepare(
                  `
              DELETE FROM booth_log
              WHERE num = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `,
                )
                .run(num, type, boothNum, stateYear)
            : db
                .prepare(
                  `
              UPDATE booth_log SET exited_at = ?
              WHERE num = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `,
                )
                .run(now, num, type, boothNum, stateYear);
        }
        if (logMutation.changes !== 1) {
          throw { status: 409, message: "부스 사용 기록이 일치하지 않습니다." };
        }

        // 연도가 바뀐 뒤 남은 점유는 완료 이력으로 오인하지 않고 미완료 transient 상태로 정리한다.
        if (!historicalState) {
          if (tableColumns(db, "inspection_history").has("team_id") && hasPersistedTeamId) {
            db.prepare(
              `
            INSERT INTO inspection_history (num, inspection, timestamp, year, team_id)
            VALUES (?, ?, ?, ?, ?)
          `,
            ).run(num, type, now, stateYear, persistedTeamId);
          } else {
            db.prepare(
              "INSERT INTO inspection_history (num, inspection, timestamp, year) VALUES (?, ?, ?, ?)",
            ).run(num, type, now, stateYear);
          }
        }

        db.prepare(
          `
        UPDATE booth
        SET occupied_by = NULL, occupied_team_id = NULL, entered_at = NULL,
            timer_paused_at = NULL, timer_paused_ms = 0
        WHERE inspection = ? AND booth_num = ?
      `,
        ).run(type, boothNum);

        return {
          num,
          teamId: hasPersistedTeamId ? persistedTeamId : null,
          stateYear,
          currentYear: current,
          normalizedHistoricalState: historicalState,
          before: boothBefore,
          logAction: historicalState ? "deleted_incomplete" : "closed",
        };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "booth.exit",
        {
          error: result.internalError || result.error,
          inspection: type,
          booth: boothNum,
          current_year: currentYear(),
          before: boothBefore,
        },
        type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "booth.exit",
      {
        inspection: type,
        booth: boothNum,
        team_id: result.result.teamId,
        team_num: result.result.num,
        state_year: result.result.stateYear,
        current_year: result.result.currentYear,
        normalized_historical_state: result.result.normalizedHistoricalState,
        before: result.result.before,
        after: {
          occupied_by: null,
          occupied_team_id: null,
          entered_at: null,
          timer_paused_at: null,
          timer_paused_ms: 0,
        },
        open_log: { action: result.result.logAction, count: 1 },
      },
      `#${result.result.num}`,
    );

    // SSE 브로드캐스트: 부스 및 대기열 변경
    broadcastBooth(type);
    broadcastQueue(type);

    res.status(200).send();
  });
}
