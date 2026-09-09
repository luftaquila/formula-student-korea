import { logAggregationTargets } from "../../../shared/server/services.mjs";
import crypto from "crypto";

export function createLogAggregationService({ logger }) {
  // 로그 집계 실패 폭주 방지: action+service별 최소 60초 간격 throttle
  const _aggWarn = new Map();

  function warnAggThrottled(action, detail, target) {
    const t = Date.now();
    const k = action + "|" + (target || "");
    const last = _aggWarn.get(k) || 0;
    if (t - last < 60000) return;
    _aggWarn.set(k, t);
    logger.warn(null, action, detail, target);
  }

  /* ============================================
   로그 집계 API
   ============================================ */
  const LOG_SERVICES = logAggregationTargets();

  // 집계 커서 토큰. 서비스별 keyset 커서("ts,id")를 하나의 opaque 문자열로 묶고,
  // 필터 해시(f)를 동봉해 "필터 A로 만든 커서로 필터 B 페이지를 잇는" 오용을 막는다
  // (프론트는 필터 변경 시 커서를 리셋하므로 이 400은 버그/수제 URL만 잡는다).
  function logFilterHash(service, filters) {
    const canonical = JSON.stringify({
      service: service || "",
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    });
    return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }

  function encodeAggCursor(filterHash, cursors) {
    return Buffer.from(JSON.stringify({ v: 1, f: filterHash, c: cursors })).toString("base64url");
  }

  function decodeAggCursor(raw) {
    try {
      const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString());
      if (
        parsed?.v !== 1 ||
        typeof parsed.f !== "string" ||
        typeof parsed.c !== "object" ||
        parsed.c === null
      )
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  return { warnAggThrottled, LOG_SERVICES, logFilterHash, encodeAggCursor, decodeAggCursor };
}
