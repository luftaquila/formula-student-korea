import crypto from "node:crypto";

export function registerSubscriptionRoutes({
  app,
  generateICalSig,
  LEGACY_EVENT_ROLES,
  logger,
  canonicalAudience,
  dbRun,
  db,
  generateICal,
}) {
  // Get signed subscription URL for current user's role
  app.get("/api/events/subscribe", (req, res) => {
    const role = req.user.role === "student" ? "student" : "official";
    const sig = generateICalSig(role);
    res.json({ role, path: `/calendar/api/events/ical?role=${role}&sig=${sig}` });
  });

  // iCal feed (signature-verified, no cookie auth)
  app.get("/api/events/ical", (req, res) => {
    const { role, sig } = req.query;
    if (!role || !sig || !LEGACY_EVENT_ROLES.includes(role)) {
      logger.warn(req, "event.ical", { error: "invalid parameters", role }, role ?? null);
      return res.status(400).send("올바르지 않은 요청입니다.");
    }

    const expected = generateICalSig(role);
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))
    ) {
      logger.warn(req, "event.ical", { error: "invalid signature", role }, role);
      return res.status(403).send("서명이 올바르지 않습니다.");
    }

    const audience = canonicalAudience(role);
    const visibleRoles =
      audience === "official"
        ? ["public", "student", "official"]
        : audience === "student"
          ? ["public", "student"]
          : ["public"];
    const placeholders = visibleRoles.map(() => "?").join(",");

    const result = dbRun(() =>
      db
        .prepare(`SELECT * FROM events WHERE role IN (${placeholders}) ORDER BY start ASC`)
        .all(...visibleRoles),
    );

    if (!result.success) {
      logger.warn(req, "event.ical", { error: result.internalError || result.error });
      return res.status(result.status).send("Internal error");
    }

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.send(generateICal(result.result));
  });
}
