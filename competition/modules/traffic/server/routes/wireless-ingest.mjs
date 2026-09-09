import { CAPTURE_LOSS, CAPTURE_CHECKPOINT } from "../../lib/wireless-capture-integrity.mjs";

export function registerWirelessIngestRoutes({
  app,
  rejectMutation,
  timingTransaction,
  stageBridgeSeen,
  db,
  validateNodeId,
  tickToText,
  validBootId,
  liveTelemetry,
  readTimingContext,
  broadcastEvent,
  enforceArmedWirelessQuality,
  processRecordEngine,
  getSessions,
  getRun,
  invalidateRun,
  getSession,
  logger,
  readLastBridgeSeenIso,
}) {
  app.post("/api/wireless/ingest", (req, res) => {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [];
    const telemetry = Array.isArray(body.telemetry) ? body.telemetry : [];
    if (events.length > 200 || telemetry.length > 200) {
      return rejectMutation(req, res, {
        action: "wireless.ingest",
        status: 400,
        message: "ingest 배치가 너무 큽니다.",
        target: "bridge",
        operation: "ingest",
        context: { counts: { events: events.length, telemetry: telemetry.length }, limit: 200 },
      });
    }

    const result = timingTransaction(() => {
      const bridge = stageBridgeSeen();
      const inserted = [];
      const acknowledged = [];
      let deduped = 0;
      let rejected = 0;
      const reasons = {}; // 사유별 카운트(로깅용)
      const reject = (why) => {
        rejected++;
        reasons[why] = (reasons[why] || 0) + 1;
      };
      const ins = db.prepare(
        "INSERT OR IGNORE INTO wireless_event (node_id, master_tick, ev_seq, rssi, snr, link_state, master_boot_id, sensor_boot_id, capture_seq, end_seq, end_tick, flags, sync_age_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const sel = db.prepare("SELECT * FROM wireless_event WHERE id = ?");
      // 불량 항목 하나가 배치 전체를 날리지 않도록 throw 대신 skip — 시리얼 라인 깨짐 등으로
      // 한 줄이 망가져도 같은 flush에 묶인 정상 이벤트는 저장·broadcast된다.
      for (const e of events) {
        if (!validateNodeId(String(e.node_id))) {
          reject("node_id");
          continue;
        }
        const tick = tickToText(e.master_tick);
        // 타이밍 이벤트는 dedupe key 전체가 필수다. SQLite UNIQUE는 NULL을 서로 다른 값으로
        // 취급하므로 누락된 key를 저장하면 재전송 멱등성이 깨진다.
        if (tick === undefined || tick === null) {
          reject("master_tick");
          continue;
        }
        if (!Number.isInteger(e.ev_seq) || e.ev_seq < 0 || e.ev_seq > 0xffff) {
          reject("ev_seq");
          continue;
        }
        if (!validBootId(e.master_boot_id)) {
          reject("master_boot_id");
          continue;
        }
        if (
          !validBootId(e.sensor_boot_id) ||
          !validBootId(e.capture_seq) ||
          !validBootId(e.end_seq) ||
          tickToText(e.end_tick) == null ||
          !Number.isInteger(e.flags) ||
          e.flags < 0 ||
          e.flags > 127 ||
          !Number.isInteger(e.sync_age_ms) ||
          e.sync_age_ms < 0 ||
          e.sync_age_ms > 65535 ||
          (e.end_seq - e.capture_seq) >>> 0 >= 0x80000000 ||
          (!(e.flags & CAPTURE_LOSS) && (e.end_seq !== e.capture_seq || e.end_tick !== tick)) ||
          (e.flags & CAPTURE_LOSS && e.flags & CAPTURE_CHECKPOINT)
        ) {
          reject("capture_evidence");
          continue;
        }
        const evSeq = e.ev_seq;
        const rssi = typeof e.rssi === "number" ? e.rssi : null;
        const snr = typeof e.snr === "number" ? e.snr : null;
        const link = typeof e.link_state === "string" ? e.link_state : null;
        const info = ins.run(
          String(e.node_id),
          tick,
          evSeq,
          rssi,
          snr,
          link,
          e.master_boot_id,
          e.sensor_boot_id,
          e.capture_seq,
          e.end_seq,
          e.end_tick,
          e.flags,
          e.sync_age_ms,
        );
        if (info.changes > 0) {
          inserted.push(sel.get(Number(info.lastInsertRowid)));
        } else if (!(e.flags & CAPTURE_CHECKPOINT)) {
          deduped++;
        }
        acknowledged.push({
          node_id: String(e.node_id),
          master_tick: tick,
          ev_seq: evSeq,
          master_boot_id: e.master_boot_id,
          sensor_boot_id: e.sensor_boot_id,
        });
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const tOut = [];
      const stagedTelemetry = new Map();
      const secLog = []; // 보안 관측(인증 실패 증가/미프로비저닝) — 트랜잭션 밖에서 logger.warn
      for (const t of telemetry) {
        if (!validateNodeId(String(t.node_id))) {
          reject("tel.node_id");
          continue;
        }
        const node = String(t.node_id);
        const rssi = typeof t.rssi === "number" ? t.rssi : null;
        const snr = typeof t.snr === "number" ? t.snr : null;
        const offset = Number.isFinite(t.offset_us) ? Math.trunc(t.offset_us) : null;
        const skew = typeof t.skew_ppm === "number" ? t.skew_ppm : null;
        const lat = typeof t.latency_ms === "number" ? t.latency_ms : null;
        const link = typeof t.link_state === "string" ? t.link_state : null;
        const rxMiss = Number.isFinite(t.rx_miss) ? Math.trunc(t.rx_miss) : null;
        const gap = Number.isFinite(t.beacon_gap) ? Math.trunc(t.beacon_gap) : null;
        // 다이 온도(deci-°C)와 배터리/충전레일(mV). 마스터(node 0)는 충전 레일 전압.
        const tempC10 = Number.isFinite(t.temp_c10) ? Math.trunc(t.temp_c10) : null;
        const battMv = Number.isFinite(t.batt_mv) ? Math.trunc(t.batt_mv) : null;
        // 보안 관측 필드(펌웨어 D 라인 신규): 인증 거부 카운터 + 프로비저닝 여부.
        const secDrop = Number.isFinite(t.sec_drop) ? Math.trunc(t.sec_drop) : null;
        const provisioned =
          t.provisioned === 0 || t.provisioned === 1
            ? t.provisioned
            : typeof t.provisioned === "boolean"
              ? t.provisioned
                ? 1
                : 0
              : null;
        const syncValid =
          t.sync_valid === 0 || t.sync_valid === 1
            ? t.sync_valid
            : typeof t.sync_valid === "boolean"
              ? t.sync_valid
                ? 1
                : 0
              : null;
        const skewValid =
          t.skew_valid === 0 || t.skew_valid === 1
            ? t.skew_valid
            : typeof t.skew_valid === "boolean"
              ? t.skew_valid
                ? 1
                : 0
              : null;
        const clockSource = ["xtal", "rc"].includes(t.clock_source) ? t.clock_source : null;
        const syncAgeMs = Number.isFinite(t.sync_age_ms)
          ? Math.max(0, Math.trunc(t.sync_age_ms))
          : null;
        const captureOverflow = Number.isFinite(t.capture_overflow)
          ? Math.max(0, Math.trunc(t.capture_overflow))
          : null;
        const eventDrop = Number.isFinite(t.event_drop)
          ? Math.max(0, Math.trunc(t.event_drop))
          : null;
        const queueDepth = Number.isFinite(t.queue_depth)
          ? Math.max(0, Math.trunc(t.queue_depth))
          : null;
        const queueOverflow = Number.isFinite(t.queue_overflow)
          ? Math.max(0, Math.trunc(t.queue_overflow))
          : null;
        const usbRefValid =
          t.usb_ref_valid === 0 || t.usb_ref_valid === 1
            ? t.usb_ref_valid
            : typeof t.usb_ref_valid === "boolean"
              ? t.usb_ref_valid
                ? 1
                : 0
              : null;
        const usbRefPpm = Number.isFinite(t.usb_ref_ppm) ? Math.trunc(t.usb_ref_ppm) : null;
        const prev = stagedTelemetry.get(node) || liveTelemetry.get(node) || {};
        // "수신"은 마스터가 그 센서를 마지막으로 들은 시각이어야 한다. 펌웨어가 진단 라인으로
        // 보내는 last_seen_ms(들은 뒤 경과 ms)를 절대시각으로 환산 — 이렇게 해야 끊김/지연을
        // 보고하는 줄이 도착해도 "수신"이 방금으로 리셋되지 않는다. 누락 시 ingest 시각으로 폴백.
        const heardAgeMs =
          Number.isFinite(t.last_seen_ms) && t.last_seen_ms >= 0
            ? Math.trunc(t.last_seen_ms)
            : null;
        const lastSeenIso = heardAgeMs === null ? nowIso : new Date(now - heardAgeMs).toISOString();
        // rx_miss/beacon_gap/sec_drop/provisioned는 실시간(SSE)으로만 — 스냅샷 테이블 스키마는 그대로.
        // 보안 이벤트 수집(인증거부 증가분 + 미프로비저닝 전이). 카운터는 보드 재부팅 시 0 리셋이라
        // 증가(secDrop>prev)일 때만 로깅 → 재부팅 후 리셋이 거짓 알림을 내지 않음.
        // baseline(prev.sec_drop)이 실재할 때만 증가를 경고한다. prev가 비었으면(첫 관측
        // 또는 liveTelemetry TTL prune 후 재등장) 없는 0 기준과 비교하지 않고 조용히
        // baseline만 세운다 — 재부팅 안 한 노드가 침묵 후 재등장할 때의 거짓 경고 방지.
        const prevHadDrop = Number.isFinite(prev.sec_drop);
        if (secDrop !== null && prevHadDrop && secDrop > prev.sec_drop) {
          secLog.push({ node, sec_drop: secDrop, delta: secDrop - prev.sec_drop });
        }
        let provWarned = prev._provWarned || false;
        if (provisioned === 0 && !provWarned) {
          secLog.push({ node, unprovisioned: true });
          provWarned = true;
        } else if (provisioned === 1) {
          provWarned = false;
        }
        const health = {
          sensor_boot_id: validBootId(t.sensor_boot_id) ? t.sensor_boot_id : null,
          master_boot_id: validBootId(t.master_boot_id) ? t.master_boot_id : null,
          sync_valid: syncValid,
          skew_valid: skewValid,
          clock_source: clockSource,
          sync_age_ms: syncAgeMs,
          capture_overflow: captureOverflow,
          event_drop: eventDrop,
          queue_depth: queueDepth,
          queue_overflow: queueOverflow,
          usb_ref_valid: usbRefValid,
          usb_ref_ppm: usbRefPpm,
        };
        const entry = {
          rssi,
          snr,
          offset_us: offset,
          skew_ppm: skew,
          latency_ms: lat,
          rx_miss: rxMiss,
          beacon_gap: gap,
          temp_c10: tempC10,
          batt_mv: battMv,
          sec_drop: secDrop,
          provisioned,
          ...health,
          link_state: link,
          last_seen: lastSeenIso,
          _provWarned: provWarned,
        };
        stagedTelemetry.set(node, entry);
        tOut.push({
          node_id: node,
          rssi,
          snr,
          offset_us: offset,
          skew_ppm: skew,
          latency_ms: lat,
          rx_miss: rxMiss,
          beacon_gap: gap,
          temp_c10: tempC10,
          batt_mv: battMv,
          sec_drop: secDrop,
          provisioned,
          ...health,
          link_state: link,
          last_seen: lastSeenIso,
        });
      }
      readTimingContext().bridge = bridge;
      readTimingContext().telemetry = stagedTelemetry;
      if (tOut.length) broadcastEvent("wireless:telemetry", { telemetry: tOut });
      enforceArmedWirelessQuality(req);
      if (inserted.length) {
        broadcastEvent("wireless:event", { events: inserted });
        processRecordEngine(inserted);
      }
      const masterBoot = stagedTelemetry.get("0")?.master_boot_id;
      if (masterBoot != null) {
        for (const session of getSessions()) {
          const run = getRun(session.event_type);
          if (session.armed && run && !run.closed && run.masterBootId !== masterBoot) {
            invalidateRun(
              session.event_type,
              run,
              [{ node_id: "0", reason: "마스터가 계측 중 재부팅되었습니다." }],
              { awaitEvidence: true },
            );
            broadcastEvent("wireless:session", getSession(session.event_type));
          }
        }
      }
      return {
        bridge,
        inserted,
        acknowledged,
        deduped,
        rejected,
        reasons,
        telemetry: tOut,
        telemetryState: [...stagedTelemetry],
        security: secLog,
      };
    });

    if (!result.success) {
      const error = result.internalError || result.error;
      logger.warn(
        req,
        "wireless.ingest",
        {
          error,
          reason: error,
          operation: "ingest",
          phase: "database_mutation",
          requested_bridge_online: true,
          counts: { events: events.length, telemetry: telemetry.length },
        },
        "bridge",
      );
      return res.status(result.status).send(result.error);
    }

    const transitioned = result.result.bridge.transitioned;
    if (transitioned) {
      logger.log(
        req,
        "wireless.bridge",
        { online: true, last_seen: readLastBridgeSeenIso() },
        "bridge",
      );
    }
    // 부분 거부는 데이터 손실 가능성이라 반드시 로깅(어떤 사유로 몇 건이 버려졌는지).
    if (result.result.rejected > 0) {
      logger.warn(req, "wireless.ingest", {
        rejected: result.result.rejected,
        reasons: result.result.reasons,
        counts: { events: events.length, telemetry: telemetry.length },
      });
    }
    const insertedIds = result.result.inserted.map((event) => Number(event.id));
    logger.log(
      req,
      "wireless.ingest",
      {
        counts: {
          events: events.length,
          telemetry: telemetry.length,
          stored: insertedIds.length,
          deduped: result.result.deduped,
          rejected: result.result.rejected,
        },
        event_id_range:
          insertedIds.length > 0
            ? { first: Math.min(...insertedIds), last: Math.max(...insertedIds) }
            : null,
        source_nodes: [
          ...new Set([...events, ...telemetry].map((item) => String(item?.node_id))),
        ].sort(),
      },
      "bridge",
    );
    // 보안 관측: 인증거부(위조/키불일치/replay 등) 증가 또는 미프로비저닝을 /api/logs로 가시화.
    // node 0 = 마스터의 AEAD 검증 실패(귀속 불가), node 1..6 = 그 센서의 인증후 거부.
    for (const s of result.result.security || []) {
      logger.warn(
        req,
        "wireless.security",
        s.unprovisioned
          ? { node: s.node, unprovisioned: true }
          : { node: s.node, sec_drop: s.sec_drop, delta: s.delta },
        `node ${s.node}`,
      );
    }
    res.json({
      stored: result.result.inserted.filter((event) => !(event.flags & CAPTURE_CHECKPOINT)).length,
      deduped: result.result.deduped,
      rejected: result.result.rejected,
      acknowledged: result.result.acknowledged,
    });
  });
}
