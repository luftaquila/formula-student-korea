export function createRegistrationRateLimits({ logger }) {
  const rateLimitMap = new Map();

  const rateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 60_000);

  function lookupRateLimit(req, res, next) {
    const ip =
      req.headers["x-real-ip"]?.trim() ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    rateLimitMap.set(ip, entry);
    if (entry.count > 60) {
      // 제한된 요청마다 SQLite에 쓰면 공격 트래픽을 로그 쓰기로 증폭한다. 창당 최초
      // 차단만 남겨도 차단 발동과 출발 IP를 감사할 수 있다.
      if (entry.count === 61) {
        logger.warn(
          req,
          "registration.lookup",
          { reason: "rate_limit", count: entry.count, ip },
          "public",
        );
      }
      return res
        .status(429)
        .json({ code: "RATE_LIMITED", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
    }
    next();
  }

  function kioskRegisterRateLimit(req, res, next) {
    if (req.user?.kind !== "device") return next();
    const ip =
      req.headers["x-real-ip"]?.trim() ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip;
    const key = `device:${req.user.id}:${ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) Object.assign(entry, { count: 0, resetAt: now + 60_000 });
    entry.count += 1;
    rateLimitMap.set(key, entry);
    if (entry.count > 30) return res.status(429).json({ code: "DEVICE_RATE_LIMITED" });
    next();
  }

  return { rateLimitTimer, lookupRateLimit, kioskRegisterRateLimit };
}
