import { EVENT_TYPES } from "../../../../../shared/common/constants.js";
import crypto from "node:crypto";
import { principalHasPermission } from "../../../../../shared/common/access-control.js";

export function registerWirelessControlRoutes({
  app,
  tickToText,
  validBootId,
  rejectMutation,
  wirelessClock,
  logger,
  readBridgeOnline,
  dbRun,
  db,
  markBridgeOffline,
  broadcastEvent,
  getBridgeState,
  readLastBridgeSeenIso,
  timingTransaction,
  enforceArmedWirelessQuality,
  getLightState,
  runMutationPreflight,
  getSession,
  wirelessActor,
  controllerEmail,
  validateSelectionRequest,
  rejectWirelessQuality,
  getLastEventId,
  pendingArmRequests,
  readWirelessClock,
  getRun,
  resetEngineRun,
  clearWirelessQualityFault,
  processRecordEngine,
  setRun,
  LEASE_TTL_MS,
  getMapping,
  validateNodeId,
  ALLOWED_ROLE,
}) {
  /* ============================================
   API 라우트: /api/wireless (무선 LoRa 계측)
   ============================================ */

  // POST /api/wireless/ingest - 브리지가 모든 센서의 타이밍 이벤트 + 진단을 push.
  // 성공은 로그하지 않음(텔레메트리 firehose); 실패·브리지 전환만 로그.
  app.post("/api/wireless/clock", (req, res) => {
    const { request_id, master_boot_id } = req.body || {};
    const master_tick = tickToText(req.body?.master_tick);
    if (
      typeof request_id !== "string" ||
      !/^[a-f0-9]{32}$/.test(request_id) ||
      master_tick == null ||
      !validBootId(master_boot_id)
    ) {
      return rejectMutation(req, res, {
        action: "wireless.clock",
        status: 400,
        message: "마스터 시각 응답이 올바르지 않습니다.",
        target: "bridge",
        operation: "clock",
        context: { request_id, master_boot_id },
      });
    }
    if (!wirelessClock.accept({ request_id, master_tick, master_boot_id })) {
      return rejectMutation(req, res, {
        action: "wireless.clock",
        status: 409,
        message: "만료되었거나 처리된 마스터 시각 응답입니다.",
        target: "bridge",
        operation: "clock",
        context: { request_id, master_boot_id },
      });
    }
    logger.log(req, "wireless.clock", { request_id, master_boot_id, master_tick }, "bridge");
    res.json({ ok: true });
  });

  // POST /api/wireless/bridge/offline - 브리지(콘솔)가 연결 해제 시 즉시 오프라인 보고.
  // 이게 없으면 15s 워치독이 풀어줄 때까지 bridge.online이 남아 "마스터 연결" 버튼이
  // 비활성으로 묶인다(새로고침해도 동일). lastBridgeSeen=0으로 둬서 실제 브리지가 아직
  // 살아있으면 다음 ingest가 바로 다시 online으로 돌린다(오인 시 self-heal).
  app.post("/api/wireless/bridge/offline", (req, res) => {
    if (readBridgeOnline()) {
      const result = dbRun(() =>
        db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run(),
      );
      if (!result.success) {
        const error = result.internalError || result.error;
        logger.warn(
          req,
          "wireless.bridge",
          {
            error,
            reason: error,
            operation: "offline",
            phase: "bridge_transition",
            requested_online: false,
          },
          "bridge",
        );
        return res.status(500).send("브리지 상태를 저장할 수 없습니다.");
      }
      markBridgeOffline();
      broadcastEvent("wireless:bridge", getBridgeState());
      logger.log(
        req,
        "wireless.bridge",
        { online: false, last_seen: readLastBridgeSeenIso() },
        "bridge",
      );
      const quality = timingTransaction(() => enforceArmedWirelessQuality(req));
      if (!quality.success) return res.status(quality.status).send(quality.error);
    }
    res.json(getBridgeState());
  });

  // PUT /api/wireless/debounce - 센서 디바운스 창(ms) 설정. 무선 공용 설정이라 wireless_light에
  // 저장하고 wireless:light로 브로드캐스트(모든 화면 공유). 0이면 디바운스 끔.
  app.put("/api/wireless/debounce", (req, res) => {
    const ms = req.body?.ms;
    if (!Number.isInteger(ms) || ms < 0 || ms > 5000) {
      return res.status(400).send("올바르지 않은 디바운스 값입니다(0~5000ms 정수).");
    }
    const result = dbRun(() => {
      db.prepare(
        "UPDATE wireless_light SET debounce_ms = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
      ).run(ms);
      return getLightState();
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.debounce",
        { error: result.internalError || result.error, ms },
        "settings",
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "wireless.debounce", { ms }, "settings");
    broadcastEvent("wireless:light", result.result);
    res.json(result.result);
  });

  // Wireless timing control. The master only supplies captures and clock responses.
  app.post("/api/wireless/arm", async (req, res) => {
    const { event_type, action } = req.body || {};
    if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
      return rejectMutation(req, res, {
        action: "wireless.arm",
        status: 400,
        message: "올바르지 않은 종목입니다.",
        target: typeof event_type === "string" ? event_type : "wireless",
        operation: action ?? "arm",
        context: { event_type: event_type ?? null },
      });
    }
    if (!["start", "stop", "reset"].includes(action)) {
      return rejectMutation(req, res, {
        action: "wireless.arm",
        status: 400,
        message: "올바르지 않은 동작입니다.",
        target: event_type,
        operation: action ?? "arm",
        context: { event_type },
      });
    }
    // A안: 해당 경기를 점유한 controller만 제어. 점유자 없으면 허용(첫 제어).
    const sessionPreflight = runMutationPreflight(req, res, {
      action: "wireless.arm",
      operation: action,
      target: event_type,
      context: { event_type },
      lookup: () => ({ session: getSession(event_type) }),
      failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
    });
    if (!sessionPreflight.ok) return;
    const sess = sessionPreflight.value.session;
    const actor = wirelessActor(req);
    if (sess?.controller && sess.controller !== actor) {
      const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
      return rejectMutation(req, res, {
        action: "wireless.arm",
        status: 409,
        message,
        target: event_type,
        operation: action,
        context: {
          event_type,
          controller: controllerEmail(sess.controller),
          requested_actor: actor,
        },
      });
    }
    if (action === "start" && sess?.armed) {
      return rejectMutation(req, res, {
        action: "wireless.arm",
        status: 409,
        message: "진행 중인 경기를 정지하거나 초기화한 뒤 다시 시작하세요.",
        target: event_type,
        operation: action,
        context: { event_type, run_id: sess.run_id, armed: true },
      });
    }
    let start_tick = null;
    if (action === "start") {
      start_tick = tickToText(req.body?.start_tick);
      if (start_tick === undefined) {
        return rejectMutation(req, res, {
          action: "wireless.arm",
          status: 400,
          message: "start_tick이 올바르지 않습니다.",
          target: event_type,
          operation: action,
          context: { event_type, start_tick: req.body?.start_tick ?? null },
        });
      }
    }
    // START 본문의 선택 또는 현재 세션의 선택을 런에 고정한다.
    const body = req.body || {};
    const hasSel = action === "start" && ("team" in body || "event_name" in body);
    let bound = null;
    if (hasSel) {
      const v = validateSelectionRequest(req, res, "wireless.arm", event_type, body);
      if (!v) return;
      if (!v.valid) {
        return rejectMutation(req, res, {
          action: "wireless.arm",
          status: v.status || 400,
          message: v.error,
          target: event_type,
          operation: action,
          context: {
            event_type,
            requested_team: body.team ?? null,
            requested_event_name: body.event_name ?? null,
          },
        });
      }
      bound = { team: v.team, event_name: v.event_name };
    }
    let clock = null;
    let clockEventCursor = null;
    if (action === "start") {
      if (rejectWirelessQuality(req, res, "wireless.arm", event_type)) return;
      bound ||= { team: sess.team, event_name: sess.event_name };
      clockEventCursor = getLastEventId();
      const request = {};
      pendingArmRequests.set(event_type, request);
      try {
        clock = await readWirelessClock({ event_type, start_tick });
        if (pendingArmRequests.get(event_type) !== request) {
          throw new Error("시각 확인 중 경기 제어 요청이 변경되었습니다. 다시 시작하세요.");
        }
        if (tickToText(clock?.master_tick) == null || !validBootId(clock?.master_boot_id)) {
          throw new Error("마스터 시각 응답이 올바르지 않습니다.");
        }
      } catch (error) {
        return rejectMutation(req, res, {
          action: "wireless.arm",
          status: 409,
          message: error.message,
          target: event_type,
          operation: action,
          context: { event_type, quality_reasons: request.qualityFailure },
        });
      } finally {
        if (pendingArmRequests.get(event_type) === request) pendingArmRequests.delete(event_type);
      }
      const current = getSession(event_type);
      if (
        current.armed ||
        current.run_id !== sess.run_id ||
        (current.controller && current.controller !== actor)
      ) {
        return rejectMutation(req, res, {
          action: "wireless.arm",
          status: 409,
          message: "시각 확인 중 경기 상태가 변경되었습니다. 다시 시작하세요.",
          target: event_type,
          operation: action,
          context: { event_type },
        });
      }
      if (rejectWirelessQuality(req, res, "wireless.arm", event_type)) return;
      start_tick = clock.master_tick;
    }
    const runId = action === "start" ? crypto.randomUUID() : null;
    const result = timingTransaction(() => {
      if (action === "start") {
        db.prepare(
          "UPDATE wireless_session SET armed = 1, team_json = ?, event_name = ?, armed_at = ?, run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
        ).run(
          bound.team ? JSON.stringify(bound.team) : null,
          bound.event_name,
          new Date().toISOString(),
          runId,
          event_type,
        );
      } else if (action === "reset") {
        db.prepare(
          "UPDATE wireless_session SET armed = 0, run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
        ).run(event_type);
      } else {
        db.prepare(
          "UPDATE wireless_session SET armed = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
        ).run(event_type);
        const run = getRun(event_type);
        if (run) run.closed = true;
      }
      if (action === "start") {
        resetEngineRun(event_type, bound, runId, clock);
        clearWirelessQualityFault(event_type);
        // A bridge may ingest an edge after the hardware capture but before its
        // clock HTTP response. Apply that committed edge to this new run once.
        const duringClock = db
          .prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id")
          .all(clockEventCursor);
        processRecordEngine(duringClock, event_type);
      } else if (action === "reset") setRun(event_type, null);
      return getSession(event_type);
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.arm",
        { error: result.internalError || result.error, event_type, action },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }
    pendingArmRequests.delete(event_type);
    logger.log(
      req,
      "wireless.arm",
      { action, start_tick, before: sess, after: result.result },
      event_type,
    );
    broadcastEvent("wireless:session", result.result);
    res.json(result.result);
  });

  // POST /api/wireless/select - 경기의 선택(팀·이벤트명)을 세션에 공유. 전 클라가 동일하게 본다.
  // 서버 권위 기록 엔진이 이 값으로 기록을 귀속(bind-at-arm은 arm 시 점등 스냅샷, 여기선 라이브 공유).
  // body: { event_type, team?: {num,univ,team}|null, event_name?: string|null }
  app.post("/api/wireless/select", (req, res) => {
    const { event_type } = req.body || {};
    if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
      return rejectMutation(req, res, {
        action: "wireless.select",
        status: 400,
        message: "올바르지 않은 종목입니다.",
        target: typeof event_type === "string" ? event_type : "wireless",
        operation: "select",
        context: { event_type: event_type ?? null, requested_team: req.body?.team ?? null },
      });
    }
    const sessionPreflight = runMutationPreflight(req, res, {
      action: "wireless.select",
      operation: "select",
      target: event_type,
      context: { event_type },
      lookup: () => getSession(event_type),
      failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
    });
    if (!sessionPreflight.ok) return;
    const sess = sessionPreflight.value;
    const actor = wirelessActor(req);
    if (sess?.controller && sess.controller !== actor) {
      const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
      return rejectMutation(req, res, {
        action: "wireless.select",
        status: 409,
        message,
        target: event_type,
        operation: "select",
        context: {
          event_type,
          controller: controllerEmail(sess.controller),
          requested_actor: actor,
          requested_team: req.body?.team ?? null,
        },
      });
    }
    // 선택 시점 검증(유선 POST /api/records와 동일 기준) — 잘못된 팀/이름은 여기서 400 → 즉시 토스트.
    // null은 선택 해제로 허용. (arm green의 bind-at-arm과 동일 검증을 공유.)
    const v = validateSelectionRequest(req, res, "wireless.select", event_type);
    if (!v) return;
    if (!v.valid) {
      return rejectMutation(req, res, {
        action: "wireless.select",
        status: v.status || 400,
        message: v.error,
        target: event_type,
        operation: "select",
        context: {
          event_type,
          requested_team: req.body?.team ?? null,
          requested_event_name: req.body?.event_name ?? null,
        },
      });
    }
    const team = v.team != null ? JSON.stringify(v.team) : null;
    const event_name = v.event_name;
    const selectionChanged =
      (sess?.event_name ?? null) !== event_name ||
      Number(sess?.team?.teamId ?? sess?.team?.id ?? 0) !==
        Number(v.team?.teamId ?? v.team?.id ?? 0) ||
      Number(sess?.team?.num ?? 0) !== Number(v.team?.num ?? 0);
    const result = dbRun(() => {
      if (selectionChanged && !sess?.armed) {
        db.prepare(
          `
        UPDATE wireless_session
        SET team_json = ?, event_name = ?, run_id = NULL, engine_state = NULL,
            saved_record_name = NULL, saved_record_rowid = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE event_type = ?
      `,
        ).run(team, event_name, event_type);
      } else {
        db.prepare(
          "UPDATE wireless_session SET team_json = ?, event_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
        ).run(team, event_name, event_type);
      }
      return getSession(event_type);
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.select",
        { error: result.internalError || result.error, event_type },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "wireless.select",
      {
        event_type,
        before: { team: sess?.team ?? null, event_name: sess?.event_name ?? null },
        after: { team: result.result?.team ?? null, event_name: result.result?.event_name ?? null },
      },
      event_type,
    );
    broadcastEvent("wireless:session", result.result);
    res.json(result.result);
  });

  // POST /api/wireless/lease/:event - 경기 독점 제어 lease 획득/갱신(heartbeat). A안.
  app.post("/api/wireless/lease/:event", (req, res) => {
    const event_type = decodeURIComponent(req.params.event);
    if (!EVENT_TYPES.includes(event_type)) {
      return rejectMutation(req, res, {
        action: "wireless.lease",
        status: 400,
        message: "올바르지 않은 종목입니다.",
        target: event_type || "wireless",
        operation: "claim",
        context: { event_type },
      });
    }
    const actor = wirelessActor(req);
    if (!actor) {
      return rejectMutation(req, res, {
        action: "wireless.lease",
        status: 401,
        message: "인증이 필요합니다.",
        target: event_type,
        operation: "claim",
        context: { event_type },
      });
    }
    const sessionPreflight = runMutationPreflight(req, res, {
      action: "wireless.lease",
      operation: "claim",
      target: event_type,
      context: { event_type },
      lookup: () => getSession(event_type),
      failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
    });
    if (!sessionPreflight.ok) return;
    const sess = sessionPreflight.value;
    if (sess?.controller && sess.controller !== actor) {
      const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
      return rejectMutation(req, res, {
        action: "wireless.lease",
        status: 409,
        message,
        target: event_type,
        operation: "claim",
        context: {
          event_type,
          controller: controllerEmail(sess.controller),
          requested_actor: actor,
        },
      });
    }
    // heartbeat(이미 내가 점유) vs 신규 점유 구분: heartbeat는 만료만 연장하고 broadcast 생략
    // (12초마다 전 클라에 불필요 fan-out 방지). 점유자 변화가 있을 때만 broadcast.
    const isHeartbeat = sess?.controller === actor;
    const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const result = dbRun(() => {
      db.prepare(
        "UPDATE wireless_session SET controller = ?, lease_expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
      ).run(actor, expires, event_type);
      return getSession(event_type);
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.lease",
        {
          error: result.internalError || result.error,
          operation: isHeartbeat ? "heartbeat" : "claim",
          event_type,
        },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "wireless.lease",
      {
        operation: isHeartbeat ? "heartbeat" : "claim",
        before: {
          controller: sess?.controller ?? null,
          lease_expires_at: sess?.lease_expires_at ?? null,
        },
        after: {
          controller: result.result?.controller ?? null,
          lease_expires_at: result.result?.lease_expires_at ?? null,
        },
      },
      event_type,
    );
    if (!isHeartbeat) broadcastEvent("wireless:session", result.result);
    res.json(result.result);
  });

  // DELETE /api/wireless/lease/:event - lease 해제(보유자 또는 계측 관리 권한의 강제 회수).
  app.delete("/api/wireless/lease/:event", (req, res) => {
    const event_type = decodeURIComponent(req.params.event);
    if (!EVENT_TYPES.includes(event_type)) {
      return rejectMutation(req, res, {
        action: "wireless.lease",
        status: 400,
        message: "올바르지 않은 종목입니다.",
        target: event_type || "wireless",
        operation: "release",
        context: { event_type },
      });
    }
    // release/takeover는 email 기준: 같은 계정은 자기 다른 세션(멈춘 탭 등)을 회수 가능,
    // 타 계정 회수는 traffic.manage(설정·전체 삭제와 같은 관리 권한)만. admin은 이를 포함한다.
    // (claim/제어는 세션 단위라 다른 세션이면 명시적 가로채기 필요.)
    const sessionPreflight = runMutationPreflight(req, res, {
      action: "wireless.lease",
      operation: "release",
      target: event_type,
      context: { event_type },
      lookup: () => getSession(event_type),
      failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
    });
    if (!sessionPreflight.ok) return;
    const sess = sessionPreflight.value;
    if (
      sess?.controller &&
      controllerEmail(sess.controller) !== (req.user?.email || null) &&
      !principalHasPermission(req.user, "traffic.manage")
    ) {
      return rejectMutation(req, res, {
        action: "wireless.lease",
        status: 409,
        message: "다른 사용자의 제어를 해제할 수 없습니다.",
        target: event_type,
        operation: "release",
        context: {
          event_type,
          controller: controllerEmail(sess.controller),
          requested_actor: req.user?.email ?? null,
        },
      });
    }
    const result = dbRun(() => {
      db.prepare(
        "UPDATE wireless_session SET controller = NULL, lease_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?",
      ).run(event_type);
      return getSession(event_type);
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.lease",
        { error: result.internalError || result.error, operation: "release", event_type },
        event_type,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "wireless.lease",
      {
        operation: "release",
        before: {
          controller: sess?.controller ?? null,
          lease_expires_at: sess?.lease_expires_at ?? null,
        },
        after: { controller: null, lease_expires_at: null },
      },
      event_type,
    );
    broadcastEvent("wireless:session", result.result);
    res.json(result.result);
  });

  // GET /api/wireless/mapping - 센서->경기·역할 매핑 전체 조회.
  app.get("/api/wireless/mapping", (req, res) => {
    const result = dbRun(() => getMapping());
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // PUT /api/wireless/mapping/:node_id - 매핑 upsert.
  app.put("/api/wireless/mapping/:node_id", (req, res) => {
    const node = req.params.node_id;
    if (!validateNodeId(node)) return res.status(400).send("node_id가 올바르지 않습니다.");
    const { event_type, role } = req.body || {};
    const label = typeof req.body?.label === "string" ? req.body.label : null;
    const enabled = req.body?.enabled === undefined ? 1 : req.body.enabled ? 1 : 0;
    if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
      return res.status(400).send("올바르지 않은 종목입니다.");
    }
    if (typeof role !== "string" || !ALLOWED_ROLE.test(role)) {
      return res.status(400).send("올바르지 않은 역할입니다.");
    }
    const result = dbRun(() => {
      const prev =
        db
          .prepare(
            "SELECT event_type, role, label, enabled FROM wireless_mapping WHERE node_id = ?",
          )
          .get(node) || null;
      db.prepare(
        `INSERT INTO wireless_mapping (node_id, event_type, role, label, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(node_id) DO UPDATE SET event_type=excluded.event_type, role=excluded.role, label=excluded.label, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      ).run(node, event_type, role, label, enabled);
      return {
        row: db
          .prepare(
            "SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping WHERE node_id = ?",
          )
          .get(node),
        prev,
      };
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.mapping",
        { error: result.internalError || result.error, event_type, role },
        node,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "wireless.mapping",
      { event_type, role, label, enabled, prev: result.result.prev },
      node,
    );
    broadcastEvent("wireless:mapping", result.result.row);
    res.json(result.result.row);
  });

  // DELETE /api/wireless/mapping/:node_id - 매핑 삭제(감사 로그).
  app.delete("/api/wireless/mapping/:node_id", (req, res) => {
    const node = req.params.node_id;
    if (!validateNodeId(node)) return res.status(400).send("node_id가 올바르지 않습니다.");
    const result = dbRun(() => {
      const prev =
        db.prepare("SELECT event_type, role FROM wireless_mapping WHERE node_id = ?").get(node) ||
        null;
      db.prepare("DELETE FROM wireless_mapping WHERE node_id = ?").run(node);
      return prev;
    });
    if (!result.success) {
      logger.warn(
        req,
        "wireless.mapping.delete",
        { error: result.internalError || result.error },
        node,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "wireless.mapping.delete", { prev: result.result }, node);
    broadcastEvent("wireless:mapping", { node_id: node, deleted: true });
    res.status(200).send();
  });
}
