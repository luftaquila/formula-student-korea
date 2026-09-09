import crypto from "node:crypto";

export function createBridgeService({
  getSessions,
  getRun,
  broadcastEvent,
  readTimingContext,
  WIRELESS_STATUS_MAX_AGE_MS,
  getMapping,
  WIRELESS_REQUIRED_ROLES,
  WIRELESS_SYNC_MAX_AGE_MS,
  WIRELESS_MAX_SKEW_PPM,
  rejectMutation,
  getSession,
  db,
  logger,
  SYS_ACTOR,
  timingTransaction,
}) {
  /* ============================================
   무선 계측: 실시간 상태(메모리) + 헬퍼
   ============================================ */
  // Latest diagnostics; active runs checkpoint their relevant nodes for recovery.
  // _provWarned suppresses duplicate provisioning warnings.
  const liveTelemetry = new Map();

  let bridgeOnline = false;

  let lastBridgeSeen = 0;

  let lastBridgeSeenIso = null;

  function getLiveTelemetry() {
    const out = [];
    for (const [node_id, t] of liveTelemetry) {
      const { _provWarned, ...publicTelemetry } = t;
      out.push({ node_id, ...publicTelemetry });
    }
    return out;
  }

  function getBridgeState() {
    return { online: bridgeOnline, last_seen: lastBridgeSeenIso };
  }

  function getLiveQualityFaults() {
    return getSessions()
      .map((session) => getRun(session.event_type)?.fault)
      .filter(Boolean);
  }

  function publishWirelessQualityFault(eventType, runId, reasons, kind = "quality") {
    const fault = {
      fault_id: crypto.randomUUID(),
      event_type: eventType,
      run_id: runId ?? null,
      kind,
      occurred_at: new Date().toISOString(),
      reasons: Array.isArray(reasons) ? reasons : [],
    };
    const run = getRun(eventType);
    if (run) run.fault = fault;
    broadcastEvent("wireless:quality-fault", fault);
    return fault;
  }

  function clearWirelessQualityFault(eventType) {
    const run = getRun(eventType);
    if (run) delete run.fault;
    broadcastEvent("wireless:quality-fault", { event_type: eventType, cleared: true });
  }

  function telemetryAgeMs(telemetry, now = Date.now()) {
    const seen = Date.parse(telemetry?.last_seen || "");
    return Number.isFinite(seen) ? Math.max(0, now - seen) : Infinity;
  }

  function wirelessQuality(eventType) {
    const reasons = [];
    const now = Date.now();
    if (
      !readTimingContext()?.bridge &&
      (!bridgeOnline || now - lastBridgeSeen > WIRELESS_STATUS_MAX_AGE_MS)
    ) {
      reasons.push({ node_id: "0", reason: "마스터 브리지가 연결되어 있지 않습니다." });
    }

    const master = readTimingContext()?.telemetry.get("0") || liveTelemetry.get("0");
    if (!master || telemetryAgeMs(master, now) > WIRELESS_STATUS_MAX_AGE_MS) {
      reasons.push({ node_id: "0", reason: "마스터 상태 보고가 없거나 오래되었습니다." });
    } else {
      if (master.link_state !== "online")
        reasons.push({ node_id: "0", reason: "마스터 계측기가 정상 상태가 아닙니다." });
      if (master.clock_source !== "xtal")
        reasons.push({ node_id: "0", reason: "마스터 HFXO가 확인되지 않았습니다." });
      if (master.provisioned !== 1)
        reasons.push({ node_id: "0", reason: "마스터 무선 키가 준비되지 않았습니다." });
    }

    const mappings = getMapping().filter(
      (row) => row.enabled !== 0 && row.event_type === eventType,
    );
    const requiredRoles = WIRELESS_REQUIRED_ROLES[eventType] || [];
    for (const role of requiredRoles) {
      if (!mappings.some((row) => row.role === role)) {
        reasons.push({ node_id: null, role, reason: `${role} 센서가 매핑되지 않았습니다.` });
      }
    }

    for (const mapping of mappings) {
      const telemetry =
        readTimingContext()?.telemetry.get(String(mapping.node_id)) ||
        liveTelemetry.get(String(mapping.node_id));
      const node = String(mapping.node_id);
      if (!telemetry || telemetryAgeMs(telemetry, now) > WIRELESS_STATUS_MAX_AGE_MS) {
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 상태 보고가 없거나 오래되었습니다.`,
        });
        continue;
      }
      if (telemetry.link_state !== "online")
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 링크가 정상이 아닙니다.`,
        });
      if (telemetry.provisioned !== 1)
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 무선 키가 준비되지 않았습니다.`,
        });
      if (telemetry.clock_source !== "xtal")
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 HFXO가 확인되지 않았습니다.`,
        });
      if (
        telemetry.sync_valid !== 1 ||
        !Number.isFinite(telemetry.sync_age_ms) ||
        telemetry.sync_age_ms > WIRELESS_SYNC_MAX_AGE_MS
      ) {
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 동기가 유효하지 않습니다.`,
        });
      }
      if (
        telemetry.skew_valid !== 1 ||
        !Number.isFinite(telemetry.skew_ppm) ||
        Math.abs(telemetry.skew_ppm) > WIRELESS_MAX_SKEW_PPM
      ) {
        reasons.push({
          node_id: node,
          role: mapping.role,
          reason: `${node} 센서 skew가 유효하지 않습니다.`,
        });
      }
    }
    return { ok: reasons.length === 0, reasons, mappings };
  }

  function rejectWirelessQuality(req, res, action, eventType) {
    const quality = wirelessQuality(eventType);
    if (quality.ok) return false;
    const message = `계측 품질 확인 실패: ${quality.reasons[0]?.reason || "상태를 확인할 수 없습니다."}`;
    rejectMutation(req, res, {
      action,
      status: 409,
      message,
      target: eventType,
      operation: "green",
      context: { event_type: eventType, quality_reasons: quality.reasons },
    });
    return true;
  }

  function enforceArmedWirelessQuality(req) {
    // Missing diagnostics are uncertainty, not evidence that a capture was lost.
    for (const session of getSessions()) {
      if (!session.armed) continue;
      const run = getRun(session.event_type);
      if (!run || run.closed || wirelessQuality(session.event_type).ok) continue;
      if (run.verification !== "pending") {
        run.verification = "pending";
        broadcastEvent("wireless:session", getSession(session.event_type));
      }
    }
  }

  // 브리지 ingest 도착 = heartbeat. 오프라인->온라인 전환 시 true 반환(SSE 발행됨).
  function stageBridgeSeen() {
    const seenAt = Date.now();
    const seenIso = new Date(seenAt).toISOString();
    const transitioned = !bridgeOnline;
    if (transitioned) {
      db.prepare("UPDATE wireless_light SET bridge_online = 1 WHERE id = 1").run();
    }
    return { seenAt, seenIso, transitioned };
  }

  function markBridgeOffline() {
    bridgeOnline = false;
    lastBridgeSeen = 0;
  }

  function commitBridgeSeen(staged) {
    lastBridgeSeen = staged.seenAt;
    lastBridgeSeenIso = staged.seenIso;
    if (staged.transitioned) {
      bridgeOnline = true;
      broadcastEvent("wireless:bridge", getBridgeState());
    }
    return staged.transitioned;
  }

  // 브리지 오프라인 감지(15s 무수신). 백그라운드라 logger는 actorOverride 사용.
  function runBridgeWatch() {
    if (bridgeOnline && Date.now() - lastBridgeSeen > 15000) {
      try {
        db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run();
        bridgeOnline = false;
        broadcastEvent("wireless:bridge", getBridgeState());
        // 명시적 offline 신고(POST /bridge/offline)와 달리 워치독 감지는 브리지가 예기치 않게
        // 죽었다는 뜻 — 운영자가 레벨 필터로 찾아야 하므로 warn.
        logger.warn(
          null,
          "wireless.bridge",
          { online: false, watchdog: true, last_seen: lastBridgeSeenIso },
          "bridge",
          SYS_ACTOR,
        );
        const quality = timingTransaction(() => enforceArmedWirelessQuality(null));
        if (!quality.success) throw new Error(quality.error);
      } catch (e) {
        logger.warn(
          null,
          "wireless.bridge",
          { error: e.message || String(e), online: false },
          "bridge",
          SYS_ACTOR,
        );
        // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
        console.error("[wireless] bridge watch:", e.message || e);
      }
    }
    return { skipped: false };
  }

  const bridgeWatch = setInterval(runBridgeWatch, 5000);

  return {
    liveTelemetry,
    readBridgeOnline: () => bridgeOnline,
    readLastBridgeSeenIso: () => lastBridgeSeenIso,
    getLiveTelemetry,
    getBridgeState,
    getLiveQualityFaults,
    publishWirelessQualityFault,
    clearWirelessQualityFault,
    telemetryAgeMs,
    rejectWirelessQuality,
    enforceArmedWirelessQuality,
    stageBridgeSeen,
    markBridgeOffline,
    commitBridgeSeen,
    runBridgeWatch,
    bridgeWatch,
  };
}
