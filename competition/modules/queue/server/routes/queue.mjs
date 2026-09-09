import { validateEntryNum } from "../../../../../shared/common/validation.mjs";
import { inspectionLastCallSms } from "../../../../../shared/common/sms-template.mjs";

export function registerQueueRoutes({
  app,
  validateInspection,
  currentYear,
  dbRun,
  getQueueRankRow,
  logger,
  smsClient,
  inspections,
  kioskRegisterRateLimit,
  validatePhone,
  getEntries,
  requestTeamActivity,
  db,
  addCurrentInspection,
  insertQueueRow,
  broadcastQueue,
  getInspectionSettings,
  getQueueStmt,
  getQueueParams,
  getQueueRow,
  deleteQueueRow,
  getCurrentEntry,
  setCurrentInspections,
  broadcastPenalties,
  sendSmsNotification,
}) {
  // POST /api/admin/inspection/:type/:num/last-call - 대기 팀에 즉시 입차 문자 발송
  app.post("/api/admin/inspection/:type/:num/last-call", async (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }
    const numValidation = validateEntryNum(req.params.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const type = typeValidation.value;
    const num = numValidation.value;
    const year = currentYear();
    const lookup = dbRun(() => getQueueRankRow(type, num, year));
    if (!lookup.success) {
      logger.warn(
        req,
        "queue.last_call",
        {
          error: lookup.internalError || lookup.error,
          phase: "queue_lookup",
          year,
          team_num: num,
          inspection: type,
        },
        `#${num}`,
      );
      return res.status(lookup.status).send(lookup.error);
    }
    if (!lookup.result) {
      logger.warn(
        req,
        "queue.last_call",
        {
          error: "queue_entry_not_found",
          year,
          team_num: num,
          inspection: type,
        },
        `#${num}`,
      );
      return res.status(404).send("대기 중인 엔트리가 아닙니다.");
    }
    if (!smsClient.isAvailable()) {
      logger.warn(
        req,
        "queue.last_call",
        {
          error: "sms_configuration_unavailable",
          year,
          team_num: num,
          inspection: type,
        },
        `#${num}`,
      );
      return res.status(503).send("SMS 설정을 사용할 수 없습니다.");
    }

    try {
      const { response, status } = await smsClient.send(
        lookup.result.phone,
        inspectionLastCallSms({ year, num, inspection: inspections[type] }),
      );
      logger.log(
        req,
        "queue.last_call",
        {
          year,
          inspection: type,
          status,
          response,
        },
        `#${num}`,
      );
      return res.status(200).send();
    } catch (error) {
      logger.warn(
        req,
        "queue.last_call",
        {
          error: error?.response || error?.message || String(error),
          code: error?.code,
          status: error?.status,
          year,
          team_num: num,
          inspection: type,
        },
        `#${num}`,
      );
      return res.status(502).send("문자 발송에 실패했습니다.");
    }
  });

  /* ============================================
   API 라우트: Admin - 대기열 등록/삭제
   ============================================ */

  // POST /api/admin/register/:type - 대기열에 엔트리 등록
  app.post("/api/admin/register/:type", kioskRegisterRateLimit, async (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.body.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const phoneValidation = validatePhone(req.body.phone);
    if (!phoneValidation.valid) {
      return res.status(400).send(phoneValidation.error);
    }

    const num = numValidation.value;
    const phone = phoneValidation.value;
    const type = typeValidation.value;
    const year = currentYear();

    try {
      const entries = await getEntries();

      if (entries[num] === undefined) {
        logger.warn(req, "queue.register", { error: "존재하지 않는 엔트리", num }, "#" + num);
        return res.status(400).send("존재하지 않는 엔트리 번호입니다.");
      }
    } catch (e) {
      logger.warn(req, "queue.entry_lookup", { error: e.message, num });
      return res.status(500).send("엔트리를 조회할 수 없습니다.");
    }

    const activity = requestTeamActivity(req, res, { action: "queue.register", num, year });
    if (!activity.ok) return;

    let denyReason = null;
    const result = dbRun(() => {
      db.transaction(() => {
        const inspection = db
          .prepare("SELECT active, hidden_from_register FROM inspection WHERE type = ?")
          .get(type);
        if (!inspection.active) {
          throw { status: 400, message: "대기열이 비활성화 상태입니다." };
        }
        if (req.user?.kind === "device" && inspection.hidden_from_register) {
          throw { status: 403, message: "접수할 수 없는 검차 종류입니다." };
        }

        if (!activity.active) {
          throw { status: 409, message: "비활성화된 엔트리는 대기열에 등록할 수 없습니다." };
        }

        // 페널티 확인
        const penalty = db
          .prepare("SELECT * FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?")
          .get(num, type, year);
        if (penalty && penalty.until > Date.now()) {
          const remaining = Math.ceil((penalty.until - Date.now()) / 1000 / 60);
          denyReason = "cancel_penalty";
          throw {
            status: 403,
            message: JSON.stringify({ remaining, until: penalty.until }),
          };
        } else if (penalty) {
          // 만료된 페널티 삭제
          db.prepare(
            "DELETE FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?",
          ).run(num, type, year);
        }

        addCurrentInspection(num, phone, type, year);

        const now = Date.now();
        insertQueueRow(type, num, phone, now, year);

        // 대기열 이벤트 로그 기록 (트랜잭션 내부)
        db.prepare(
          "INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)",
        ).run("register", num, type, now, year);
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "queue.register",
        denyReason
          ? { error: result.internalError || result.error, reason: denyReason }
          : { error: result.internalError || result.error },
        `#${num}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "queue.register", { inspection: type, phone }, `#${num}`);

    // SSE 브로드캐스트: 대기열 변경
    broadcastQueue(type);

    res.status(201).send();
  });

  // POST /api/admin/cancel/:type - 대기열에서 엔트리 취소 (페널티 적용)
  app.post("/api/admin/cancel/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.body.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const num = numValidation.value;
    const type = typeValidation.value;
    const year = currentYear();

    const result = dbRun(() => {
      return db.transaction(() => {
        let appliedPenalty = null;
        // SMS 대상 조회도 취소 mutation의 preflight다. 실패하면 삭제를 시작하지
        // 않고 동일한 audited boundary에서 응답한다.
        const settings = getInspectionSettings(type);
        const smsRank = settings.smsRank;
        const prev = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);
        const queueEntry = getQueueRow(type, num, year);
        if (!queueEntry) {
          throw { status: 400, message: "존재하지 않는 엔트리입니다." };
        }
        deleteQueueRow(type, num, year);

        // 페널티 적용
        const penaltyMinutes = settings.cancelPenalty;
        if (penaltyMinutes > 0) {
          const until = Date.now() + penaltyMinutes * 60 * 1000;
          appliedPenalty = { minutes: penaltyMinutes, until };
          db.prepare(
            `
          INSERT OR REPLACE INTO cancel_penalty
            (num, inspection, year, until, phone, queue_timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          ).run(num, type, year, until, queueEntry.phone, queueEntry.timestamp);
        }

        const current = getCurrentEntry(num, year);

        if (!current) {
          throw { status: 400, message: "현재 등록 상태를 찾을 수 없습니다." };
        }

        const remaining = current.inspections.filter((i) => i !== type);
        setCurrentInspections(num, current.phone, remaining, year);

        // 대기열 이벤트 로그 기록 (트랜잭션 내부)
        db.prepare(
          "INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)",
        ).run("cancel", num, type, Date.now(), year);
        return { prev, appliedPenalty };
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "queue.cancel",
        {
          error: result.internalError || result.error,
          phase: "mutation_preflight",
          year,
          team_num: num,
          inspection: type,
        },
        `#${num}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "queue.cancel",
      result.result.appliedPenalty
        ? {
            inspection: type,
            penalty_minutes: result.result.appliedPenalty.minutes,
            penalty_until: result.result.appliedPenalty.until,
          }
        : { inspection: type, penalty: false },
      `#${num}`,
    );

    // SSE 브로드캐스트: 대기열 변경
    broadcastQueue(type);
    broadcastPenalties();

    res.status(200).send();

    // SMS 발송 (N번째 대기자에게)
    sendSmsNotification(type, result.result.prev);
  });
}
