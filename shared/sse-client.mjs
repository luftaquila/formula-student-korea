import http from "node:http";

// SSE 메시지 파싱용 정규식 (모듈 스코프에 캐싱)
const EVENT_RE = /^event:\s*(.+)$/m;
const DATA_RE = /^data:\s*(.*)$/gm;

// 서버 사이드 SSE 구독 클라이언트 (score의 업스트림 재전파용 구현을 일반화한 것).
// node:http 기반 수동 프레임 파싱 — 중복 연결 방지 + exponential backoff(초기 3s → 최대
// 30s, 성공 시 리셋) + 1MiB 버퍼 오버플로 가드 + 60s 유휴 타임아웃.
//
// - allowedEvents: 처리할 이벤트 이름 화이트리스트(Set). null=전부. 업스트림 firehose
//   (예: traffic wireless 텔레메트리)가 핸들러 없는 소비자에게 흘러가는 것을 막는다.
// - onEvent(name, data): 파싱된 JSON payload 콜백.
// - onReconnect(): 끊겼다 재연결에 성공한 시점 콜백(스냅샷 재조회 신호용).
// - onWarn(kind, detail): kind ∈ subscribe_failed | overflow | parse_error | disconnect.
//   detail에는 항상 { source: name }이 포함된다.
// - headers: 객체 또는 함수(연결 시점마다 평가 — env 재읽기용).
//
// 반환: { start, stop }. stop()은 테스트·종료용 — 소켓을 닫고 재연결을 멈춘다.
export function createSSESubscriber({
  name,
  url,
  headers = {},
  allowedEvents = null,
  onEvent,
  onReconnect,
  onWarn = () => {},
  idleTimeoutMs = 60000,
  maxBufferBytes = 1024 * 1024,
  initialBackoffMs = 3000,
  maxBackoffMs = 30000,
}) {
  let reconnecting = false;
  let connected = false;
  let stopped = false;
  let backoff = initialBackoffMs;
  let currentReq = null;
  let reconnectTimer = null;

  function subscribe() {
    if (reconnecting || stopped) return;

    const options = { headers: typeof headers === "function" ? headers() : headers };
    const req = http.get(new URL(url), options, (res) => {
      if (res.statusCode !== 200) {
        // 비200 응답(403 시크릿 불일치, 503 maxClients 등)은 연결 성공이 아니다.
        // backoff를 리셋하지 않아야 영구 실패가 3초 간격 무한 재시도로 상대 서비스를
        // 두드리지 않고, 로깅해야 설정 오류가 조용히 묻히지 않는다.
        onWarn("subscribe_failed", { source: name, status: res.statusCode });
        res.resume();
        res.on("end", () => scheduleReconnect());
        return;
      }

      connected = true;
      const wasReconnect = backoff > initialBackoffMs;
      backoff = initialBackoffMs; // 연결 성공 시 backoff 리셋
      if (wasReconnect && onReconnect) onReconnect();
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > maxBufferBytes) {
          onWarn("overflow", { source: name });
          buffer = "";
          return;
        }
        const messages = buffer.split("\n\n");
        buffer = messages.pop();

        for (const msg of messages) {
          try {
            const eventMatch = msg.match(EVENT_RE);
            if (!eventMatch) continue;
            const evName = eventMatch[1].trim();
            // 화이트리스트 밖 이벤트는 파싱·전달하지 않는다(firehose 차단).
            if (allowedEvents && !allowedEvents.has(evName)) continue;
            const dataLines = msg.match(DATA_RE);
            if (!dataLines) continue;
            const jsonStr = dataLines.map((l) => l.replace(/^data:\s*/, "")).join("\n");
            onEvent(evName, JSON.parse(jsonStr));
          } catch (e) {
            onWarn("parse_error", { source: name, error: e.message });
          }
        }
      });

      // 'end'는 정상 종료에만 온다. 소켓 리셋·서버 크래시 같은 비정상 단절은 'end' 없이
      // 'error'('aborted'/ECONNRESET)와 'close'만 emit하므로, 둘 다 재연결 경로에 태운다 —
      // 안 잡으면 구독이 조용히 죽은 채 남고('close' 미처리), response 'error'는 미처리 시
      // 프로세스를 죽인다. scheduleReconnect의 reconnecting 가드가 중복 예약을 막는다.
      res.on("end", () => {
        scheduleReconnect();
      });
      res.on("error", () => {
        scheduleReconnect();
      });
      res.on("close", () => {
        scheduleReconnect();
      });
    });
    currentReq = req;

    req.setTimeout(idleTimeoutMs, () => {
      // 유휴 타임아웃(keepalive 두절/half-open 소켓)에서 인자 없는 destroy()는 'error'를
      // emit하지 않고, 스트리밍 중이던 res도 'end' 대신 'aborted'/'close'로 끝나므로 여기서
      // 재연결을 직접 예약해야 한다. scheduleReconnect의 reconnecting 가드가 중복을 막는다.
      req.destroy();
      scheduleReconnect();
    });
    req.on("error", () => {
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (connected) {
      onWarn("disconnect", { source: name });
      connected = false;
    }
    if (reconnecting) return;
    reconnecting = true;
    reconnectTimer = setTimeout(() => {
      reconnecting = false;
      backoff = Math.min(backoff * 2, maxBackoffMs);
      subscribe();
    }, backoff);
    reconnectTimer.unref?.();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (currentReq) currentReq.destroy();
  }

  return { start: subscribe, stop };
}
