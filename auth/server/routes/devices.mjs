import { DEVICE_SCOPES } from "../../../shared/common/access-control.js";
import crypto from "crypto";
import { isSecureConnection, formatCookieOpts } from "../../../shared/server/express-setup.mjs";

export function registerDevicesRoutes({
  app,
  dbRun,
  db,
  deviceResponse,
  logger,
  issuePairingCode,
  validateDevice,
  requestIp,
  pairingLimiter,
  pairingCodeHash,
  tokenHash,
}) {
  app.get("/api/devices", (req, res) => {
    const result = dbRun(() =>
      db.prepare("SELECT * FROM kiosk_device ORDER BY created_at DESC, id").all(),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result.map(deviceResponse));
  });

  app.post("/api/devices", (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const scope = req.body?.scope;
    if (!name || name.length > 80) {
      logger.warn(req, "device.create", { reason: "invalid_name", name_length: name.length });
      return res.status(400).json({ code: "INVALID_DEVICE_NAME" });
    }
    if (!DEVICE_SCOPES.includes(scope)) {
      logger.warn(req, "device.create", { reason: "invalid_scope", scope });
      return res.status(400).json({ code: "INVALID_DEVICE_SCOPE" });
    }
    const id = crypto.randomUUID();
    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO kiosk_device (id, name, scope, created_by) VALUES (?, ?, ?, ?)",
        ).run(id, name, scope, req.user.id || null);
        return issuePairingCode(id);
      })(),
    );
    if (!result.success) {
      logger.warn(req, "device.create", {
        error: result.internalError || result.error,
        name,
        scope,
      });
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "device.create", { id, name, scope }, id);
    res.status(201).json({ id, name, scope, ...result.result });
  });

  app.post("/api/devices/:id/pairing-code", (req, res) => {
    const device = db
      .prepare("SELECT id, name, scope FROM kiosk_device WHERE id = ?")
      .get(req.params.id);
    if (!device) {
      logger.warn(req, "device.pairing_code", { reason: "not_found" }, req.params.id);
      return res.status(404).json({ code: "DEVICE_NOT_FOUND" });
    }
    const result = dbRun(() => issuePairingCode(device.id));
    if (!result.success) {
      logger.warn(
        req,
        "device.pairing_code",
        { error: result.internalError || result.error },
        device.id,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "device.pairing_code", { name: device.name, scope: device.scope }, device.id);
    res.json({ id: device.id, ...result.result });
  });

  app.post("/api/devices/:id/revoke", (req, res) => {
    const device = db
      .prepare("SELECT id, name, scope, revoked_at FROM kiosk_device WHERE id = ?")
      .get(req.params.id);
    if (!device) {
      logger.warn(req, "device.revoke", { reason: "not_found" }, req.params.id);
      return res.status(404).json({ code: "DEVICE_NOT_FOUND" });
    }
    const result = dbRun(() =>
      db
        .prepare(
          `
    UPDATE kiosk_device
    SET token_hash = NULL, pairing_code_hash = NULL, pairing_code_expires_at = NULL,
        revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `,
        )
        .run(device.id),
    );
    if (!result.success) {
      logger.warn(req, "device.revoke", { error: result.internalError || result.error }, device.id);
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "device.revoke", { name: device.name, scope: device.scope }, device.id);
    res.status(200).send();
  });

  app.post("/api/devices/validate", (req, res) => {
    const result = validateDevice(req.headers["x-device-token"]);
    if (!result.valid) return res.status(404).send();
    res.json({ id: result.id, name: result.name, scope: result.scope });
  });

  app.post("/api/device/pair", (req, res) => {
    const ip = requestIp(req);
    const now = Date.now();
    const limit = pairingLimiter.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (limit.resetAt <= now) Object.assign(limit, { count: 0, resetAt: now + 60_000 });
    limit.count += 1;
    pairingLimiter.set(ip, limit);
    if (limit.count > 10) {
      if (limit.count === 11) logger.warn(req, "device.pair_rate_limit", { ip });
      return res.status(429).json({ code: "PAIRING_RATE_LIMITED" });
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
    const hash = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)
      ? pairingCodeHash(code)
      : "invalid";
    const device = db
      .prepare(
        `
    SELECT id, name, scope FROM kiosk_device
    WHERE pairing_code_hash = ?
      AND pairing_code_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND revoked_at IS NULL
  `,
      )
      .get(hash);
    if (!device) {
      logger.warn(req, "device.pair_failed", { reason: "invalid_or_expired_code", ip });
      return res.status(401).json({ code: "INVALID_OR_EXPIRED_PAIRING_CODE" });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const result = dbRun(() =>
      db.transaction(() => {
        const consumed = db
          .prepare(
            `
      UPDATE kiosk_device
      SET token_hash = ?, pairing_code_hash = NULL, pairing_code_expires_at = NULL,
          paired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_at = NULL
      WHERE id = ? AND pairing_code_hash = ?
        AND pairing_code_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `,
          )
          .run(tokenHash(token), device.id, hash);
        if (consumed.changes !== 1) throw { status: 401, message: "페어링 코드가 만료되었습니다." };
      })(),
    );
    if (!result.success) {
      logger.warn(req, "device.pair_failed", { reason: "code_consumed", device_id: device.id });
      return res.status(401).json({ code: "INVALID_OR_EXPIRED_PAIRING_CODE" });
    }

    const secure = isSecureConnection(req);
    const humanCookieOpts = formatCookieOpts(0, secure);
    const maxAge = 400 * 24 * 3600;
    const deviceCookieOpts = `Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
    res.setHeader("Set-Cookie", [
      `fsk_session=; HttpOnly; ${humanCookieOpts}`,
      `fsk_user=; ${humanCookieOpts}`,
      `fsk_device=${encodeURIComponent(token)}; HttpOnly; ${deviceCookieOpts}`,
    ]);
    logger.log(req, "device.pair", { name: device.name, scope: device.scope }, device.id, {
      email: `device:${device.id}`,
      name: device.name,
      role: "device",
    });
    res.json({
      id: device.id,
      name: device.name,
      scope: device.scope,
      startPath:
        device.scope === "kiosk.queue.register" ? "/queue/register" : "/registration/register",
    });
  });
}
