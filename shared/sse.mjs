export function createSSEManager(maxClients = 200) {
  // 각 클라이언트는 { res, meta }. meta에는 연결 시점의 { ip, ...(metaFn 결과) }가 담긴다.
  // role 같은 값을 metaFn으로 넣으면 broadcast의 filterFn으로 대상을 좁힐 수 있다.
  const clients = new Set();
  // per-IP 연결 수(선택적 상한용).
  const ipCounts = new Map();

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
  setInterval(() => {
    for (const client of clients) writeTo(client, ": keepalive\n\n");
  }, 30000).unref();

  // 선택적 주기 재검증: revalidate가 등록된 연결만 대상(예: course rover SSE의 role 재확인).
  // 연결 시점 meta는 스냅샷이라 강등이 재연결 전까지 반영 안 되는데(즉시-권한-반영 원칙 위배),
  // 여기서 주기적으로 최신 상태를 meta에 반영하거나(→ filterFn이 재평가) 자격 상실 시 연결을
  // 종료한다. revalidate가 throw하면(auth 일시 오류) 연결을 유지한다(fail-open, validateUser의
  // transient 처리와 동일). null 반환 = 이 SSE 자격 없음 → 종료. meta 객체 반환 = 갱신.
  setInterval(async () => {
    for (const client of clients) {
      if (!client.revalidate) continue;
      let next;
      try {
        next = await client.revalidate(client.meta);
      } catch {
        continue; // 일시 오류 → 연결 유지
      }
      if (next == null) {
        try { client.res.end(); } catch {}
        removeClient(client);
      } else {
        client.meta = next;
      }
    }
  }, 30000).unref();

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
      if (clients.size >= maxClients) {
        return res.status(503).send("연결이 너무 많습니다. 잠시 후 다시 시도해주세요.");
      }
      const ip = clientIp(req);
      if (maxPerIp > 0 && (ipCounts.get(ip) || 0) >= maxPerIp) {
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
      } catch {
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

  return { broadcast, handler };
}

function clientIp(req) {
  // Caddy가 신뢰경계로 해석해 세팅한 X-Real-IP를 우선(위조 불가). 없으면(비-caddy/테스트)
  // 기존 X-Forwarded-For 최좌측 → req.ip 로 폴백.
  return req.headers?.["x-real-ip"]?.trim() || req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "";
}
