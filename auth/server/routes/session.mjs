import { PERMISSION_KEYS, principalHasPermission } from "../../../shared/common/access-control.js";

export function registerSessionRoutes({ app, logger, isForwardAuthKey }) {
  app.get("/api/logs", logger.queryHandler);

  app.get("/api/health", (req, res) => res.send("ok"));

  // Session validation endpoint (landing page uses this to verify cookie state)
  app.get("/api/session", (req, res) => {
    if (req.user?.kind !== "human") return res.status(401).send();
    res.json({
      name: req.user.name,
      picture: req.user.picture || "",
      role: req.user.role,
      permissions: req.user.permissions,
      accessRevision: req.user.accessRevision,
    });
  });

  app.get("/api/device/session", (req, res) => {
    if (req.user?.kind !== "device") return res.status(401).json({ code: "DEVICE_AUTH_REQUIRED" });
    res.json({
      id: req.user.id,
      name: req.user.name,
      scope: req.user.scope,
      startPath:
        req.user.scope === "kiosk.queue.register" ? "/queue/register" : "/registration/register",
    });
  });

  app.get("/api/forward-auth", (req, res) => {
    const key = req.headers["x-forward-auth-key"];
    if (!key || !process.env.INTERNAL_SECRET) {
      logger.warn(req, "auth.forward_auth_denied", { reason: "missing_key_or_secret" });
      return res.status(403).send();
    }
    if (!isForwardAuthKey(key)) {
      logger.warn(req, "auth.forward_auth_denied", { reason: "key_mismatch" });
      return res.status(403).send();
    }
    const requiredPermission = String(req.query.permission || "");
    if (!PERMISSION_KEYS.includes(requiredPermission)) {
      logger.warn(req, "auth.forward_auth_denied", {
        reason: "unknown_permission",
        required: requiredPermission,
      });
      return res.status(400).send("알 수 없는 권한입니다.");
    }
    if (req.user?.kind !== "human") {
      logger.warn(req, "auth.forward_auth_denied", { reason: "no_user" });
      return res.status(401).send("인증이 필요합니다.");
    }
    if (!principalHasPermission(req.user, requiredPermission)) {
      logger.warn(
        req,
        "auth.forward_auth_denied",
        {
          required: requiredPermission,
          actual: req.user.permissions,
        },
        req.user.email,
      );
      return res.status(403).send("권한이 없습니다.");
    }
    res.setHeader("X-Forwarded-User", req.user.email);
    res.status(200).send();
  });
}
