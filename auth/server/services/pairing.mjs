import crypto from "crypto";

export function createPairingService({ db }) {
  /* ============================================
   Kiosk device pairing and lifecycle
   ============================================ */
  const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

  const pairingLimiter = new Map();

  const pairingLimiterTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, value] of pairingLimiter) if (value.resetAt <= now) pairingLimiter.delete(ip);
  }, 60_000);

  function requestIp(req) {
    return (
      req.headers["x-real-ip"]?.trim() ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip
    );
  }

  function pairingCodeHash(code) {
    return crypto
      .createHmac("sha256", process.env.JWT_SECRET || "")
      .update(`kiosk-pair:${code}`)
      .digest("base64url");
  }

  function createPairingCode() {
    return [...crypto.randomBytes(8)].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
  }

  function issuePairingCode(id) {
    const code = createPairingCode();
    db.prepare(
      `
    UPDATE kiosk_device
    SET pairing_code_hash = ?,
        pairing_code_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'),
        token_hash = NULL,
        revoked_at = NULL
    WHERE id = ?
  `,
    ).run(pairingCodeHash(code), id);
    const expiresAt = db
      .prepare("SELECT pairing_code_expires_at FROM kiosk_device WHERE id = ?")
      .get(id)?.pairing_code_expires_at;
    return { pairingCode: code, pairingCodeExpiresAt: expiresAt };
  }

  function deviceResponse(row) {
    return {
      id: row.id,
      name: row.name,
      scope: row.scope,
      status: row.revoked_at
        ? "revoked"
        : row.token_hash
          ? "active"
          : row.pairing_code_hash
            ? "pending"
            : "unpaired",
      pairingPending: !row.revoked_at && !!row.pairing_code_hash,
      pairingCodeExpiresAt: row.pairing_code_expires_at,
      createdAt: row.created_at,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      createdBy: row.created_by,
    };
  }

  return {
    pairingLimiter,
    pairingLimiterTimer,
    requestIp,
    pairingCodeHash,
    issuePairingCode,
    deviceResponse,
  };
}
