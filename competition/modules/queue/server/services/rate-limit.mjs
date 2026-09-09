export function createQueueRateLimits() {
  // Rate limiter for public endpoints
  const rateLimitMap = new Map();

  const rateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 60000);

  function rateLimit(req, res, next) {
    // Caddy가 세팅한 신뢰 X-Real-IP 우선(위조 불가), 없으면 X-Forwarded-For 최좌측 → req.ip 폴백.
    const ip =
      req.headers["x-real-ip"]?.trim() ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60000;
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > 30) return res.status(429).send("요청이 너무 많습니다.");
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
    const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60000;
    }
    entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > 30) return res.status(429).json({ code: "DEVICE_RATE_LIMITED" });
    next();
  }

  return { rateLimitTimer, rateLimit, kioskRegisterRateLimit };
}
