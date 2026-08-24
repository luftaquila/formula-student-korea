export function createSSEManager(maxClients = 200, { logger = null } = {}) {
  // 각 클라이언트는 { res, meta }. meta에는 연결 시점의 { ip, ...(metaFn 결과) }가 담긴다.
  // role 같은 값을 metaFn으로 넣으면 broadcast의 filterFn으로 대상을 좁힐 수 있다.
  const clients = new Set();
  let closed = false;
  // per-IP 연결 수(선택적 상한용).
  const ipCounts = new Map();

  // 용량 거부(503/429)·init 스냅샷 실패는 운영자가 봐야 하는 이벤트지만, DoS·깨진
  // initDataFn 아래에서는 초당 수백 번 발생할 수 있어 같은 사유는 60초에 1회만 남긴다.
  const lastWarnAt = new Map();
  function warnThrottled(req, action, reason, detail) {
    if (!logger) return;
    const now = Date.now();
    const key = `${action}:${reason}`;
    if (now - (lastWarnAt.get(key) || 0) < 60_000) return;
    lastWarnAt.set(key, now);
    logger.warn(req, action, { reason, ...detail });
  }

  // 백프레셔: 커널 송신 버퍼가 이 이상 밀린(느린/half-open) 클라이언트는 끊는다.
  // SSE 클라이언트는 자동 재연결 + init 스냅샷으로 복구하므로 끊는 것이 안전하다.
  const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

  function removeClient(client) {
    if (!clients.delete(client)) return;
    const ip = client.meta?.ip;
    if (ip && ipCounts.has(ip)) {
      const n = ipCounts.get(ip) - 1;
      if (n <= 0) ipCounts.delete(ip);
      else ipCounts.set(ip, n);
    }
  }

  function writeTo(client, message) {
    const { res } = client;
    try {
      // writableLength 미지원(mock) 시 undefined > N === false라 무해.
      if (res.writableLength > BACKPRESSURE_BYTES) {
        removeClient(client);
        res.destroy();
        return;
      }
      res.write(message);
    } catch {
      removeClient(client);
    }
  }

  // broadcast(event, data)            — 전 클라이언트.
  // broadcast(event, data, filterFn)  — filterFn(meta)===true인 연결에만(예: role 필터).
  function broadcast(event, data, filterFn) {
    const safeEvent = String(event).replace(/[\r\n]/g, "");
    const message = `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (filterFn && !filterFn(client.meta)) continue;
      writeTo(client, message);
    }
  }

  // Heartbeat to keep connections alive through proxies
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) writeTo(client, ": keepalive\n\n");
  }, 30000);
  heartbeatTimer.unref();

  // 선택적 주기 재검증: revalidate가 등록된 연결만 대상(예: course rover SSE의 role 재확인).
  // 연결 시점 meta는 스냅샷이라 강등이 재연결 전까지 반영 안 되는데(즉시-권한-반영 원칙 위배),
  // 여기서 주기적으로 최신 상태를 meta에 반영하거나(→ filterFn이 재평가) 자격 상실 시 연결을
  // 종료한다. revalidate가 throw하면(auth 일시 오류) 연결을 유지한다(fail-open, validateUser의
  // transient 처리와 동일). null 반환 = 이 SSE 자격 없음 → 종료. meta 객체 반환 = 갱신.
  //
  // 루프는 의도적으로 직렬이다. app.validateUser의 5초 캐시 + in-flight 병합 덕에 같은
  // 이메일은 왕복 한 번으로 합쳐지고, 직렬 순회는 auth로의 동시 요청을 1개로 묶는다 —
  // 병렬화하면 auth가 느려진 바로 그 순간(재검증이 오래 걸리는 순간)에 herd를 되살린다.
  const revalidationTimer = setInterval(async () => {
    for (const client of clients) {
      if (closed) break;
      if (!client.revalidate) continue;
      let next;
      try {
        next = await client.revalidate(client.meta);
      } catch {
        continue; // 일시 오류 → 연결 유지
      }
      if (closed) break;
      if (next == null) {
        try { client.res.end(); } catch {}
        removeClient(client);
      } else {
        client.meta = next;
      }
    }
  }, 30000);
  revalidationTimer.unref();

  // handler(initDataFn)
  // handler(initDataFn, { meta: (req) => ({...}), maxPerIp })
  //  - meta: 연결에 태깅할 메타(예: { role: req.user?.role }) — broadcast filterFn에서 사용.
  //  - maxPerIp: 동일 IP 동시 연결 상한(공개 SSE의 비인증 연결 고갈 DoS 완화).
  //  - revalidate: async (meta) => meta|null. 위 타이머가 주기적으로 호출해 role 등을 재검증.
  function handler(initDataFn, opts = {}) {
    const metaFn = opts.meta || null;
    const maxPerIp = opts.maxPerIp || 0;
    const revalidate = opts.revalidate || null;
    return (req, res) => {
      if (closed) {
        return res.status(503).send("서버가 종료 중입니다. 잠시 후 다시 시도해주세요.");
      }
      if (clients.size >= maxClients) {
        // 상한 도달 = 실제 사용자가 서비스 전체에서 거절당하는 중.
        warnThrottled(req, "sse.rejected", "max_clients", { clients: clients.size });
        return res.status(503).send("연결이 너무 많습니다. 잠시 후 다시 시도해주세요.");
      }
      const ip = clientIp(req);
      if (maxPerIp > 0 && (ipCounts.get(ip) || 0) >= maxPerIp) {
        // per-IP 상한 = DoS 완화 장치가 발동한 것.
        warnThrottled(req, "sse.rejected", "max_per_ip", { count: ipCounts.get(ip) || 0 });
        return res.status(429).send("동시 연결이 너무 많습니다.");
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // initDataFn 예외가 flushHeaders 이후 응답을 파손하지 않도록 방어.
      let initData = {};
      try {
        initData = initDataFn ? initDataFn(req) : {};
      } catch (e) {
        // 깨진 initDataFn은 모든 새 연결을 빈 스냅샷으로 조용히 강등시킨다 — 반드시 보여야 한다.
        warnThrottled(req, "sse.init_failed", "init_data", { error: e.message || String(e) });
        initData = {};
      }
      try {
        res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);
      } catch {
        return; // 클라이언트가 이미 끊김
      }

      const meta = { ip, ...(metaFn ? metaFn(req) : {}) };
      const client = { res, meta, revalidate };
      clients.add(client);
      if (maxPerIp > 0) ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);

      req.on("close", () => removeClient(client));
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearInterval(revalidationTimer);
    for (const client of [...clients]) {
      try { client.res.end(); } catch {}
      removeClient(client);
    }
  }

  return { broadcast, handler, close };
}

function clientIp(req) {
  // Caddy가 신뢰경계로 해석해 세팅한 X-Real-IP를 우선(위조 불가). 없으면(비-caddy/테스트)
  // 기존 X-Forwarded-For 최좌측 → req.ip 로 폴백.
  return req.headers?.["x-real-ip"]?.trim() || req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "";
}
