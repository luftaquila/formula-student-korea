import { PERMISSION_KEYS, expandPermissions } from "../../shared/common/access-control.js";
import crypto from "crypto";

export function createAuthStore({ db }) {
  /* ============================================
   Express 앱 설정
   ============================================ */
  function accessRows(userId) {
    return db
      .prepare(
        "SELECT permission_key FROM user_permission WHERE user_id = ? ORDER BY permission_key",
      )
      .all(userId)
      .map((row) => row.permission_key);
  }

  function userAccess(user) {
    const grants = user.role === "official" ? accessRows(user.id) : [];
    const permissions =
      user.role === "admin"
        ? [...PERMISSION_KEYS]
        : user.role === "official"
          ? expandPermissions(grants)
          : [];
    return {
      grants,
      permissions,
      accessRevision: Number(user.access_revision) || 0,
    };
  }

  const validateUser = (email) => {
    const user = db
      .prepare(
        "SELECT id, role, realname, access_revision FROM users WHERE email = ? AND active = 1",
      )
      .get(email);
    return user
      ? {
          valid: true,
          id: user.id,
          role: user.role,
          realname: user.realname || "",
          ...userAccess(user),
        }
      : { valid: false, role: null };
  };

  function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("base64url");
  }

  const validateDevice = (token) => {
    if (typeof token !== "string" || token.length < 32) return { valid: false };
    const row = db
      .prepare(
        `
    SELECT id, name, scope, last_seen_at
    FROM kiosk_device
    WHERE token_hash = ? AND revoked_at IS NULL
  `,
      )
      .get(tokenHash(token));
    if (!row) return { valid: false };
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= 60 * 60 * 1000) {
      db.prepare(
        "UPDATE kiosk_device SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      ).run(row.id);
    }
    return { valid: true, id: row.id, name: row.name, scope: row.scope };
  };

  /* ============================================
   계정 신청 헬퍼
   ============================================ */
  // 신청 접수가 열려 있는지
  const isApplicationsOpen = () =>
    db.prepare("SELECT value FROM settings WHERE key = 'applications_open'").get()?.value === "1";

  return { userAccess, validateUser, tokenHash, validateDevice, isApplicationsOpen };
}
