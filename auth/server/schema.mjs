import {
  addColumn,
  runMigrationOnce,
  normalizeTimestampColumn,
} from "../../shared/server/db-setup.mjs";
import { PERMISSION_KEYS, normalizeAccessGrants } from "../../shared/common/access-control.js";

export function initializeSchema({ db, LEGACY_PERMISSION_BUNDLES }) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'official', 'student')),
  memo TEXT DEFAULT '',
  realname TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT,
  active INTEGER DEFAULT 1,
  affiliation TEXT DEFAULT '',
  access_revision INTEGER NOT NULL DEFAULT 0
)`);

  // 마이그레이션: memo 컬럼 추가
  addColumn(db, "users", "memo TEXT DEFAULT ''");

  // 마이그레이션: active 컬럼 추가
  addColumn(db, "users", "active INTEGER DEFAULT 1");

  // 마이그레이션: realname, phone 컬럼 추가 (memo → realname 전환)
  addColumn(db, "users", "realname TEXT DEFAULT ''");

  addColumn(db, "users", "phone TEXT DEFAULT ''");

  addColumn(db, "users", "affiliation TEXT DEFAULT ''");

  addColumn(db, "users", "access_revision INTEGER NOT NULL DEFAULT 0");

  db.exec(
    "UPDATE users SET realname = memo WHERE (realname IS NULL OR realname = '') AND memo IS NOT NULL AND memo != ''",
  );

  // 마이그레이션: created_at 기본값 제거 (최초 로그인 시점으로 변경)
  // 아직 로그인하지 않은 사용자(name IS NULL)의 created_at 초기화
  db.exec("UPDATE users SET created_at = NULL WHERE name IS NULL AND created_at IS NOT NULL");

  // Final account model: operational ranks collapse to a permission-less Official.
  // Foreign keys are disabled outside the rebuilding transaction so existing
  // ops_display references survive the users table replacement.
  const roleCheck = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  const hasRetiredRoleSchema = roleCheck && /'(?:staff|chief|master)'/.test(roleCheck.sql);

  const retiredRoleUserIds = hasRetiredRoleSchema
    ? db
        .prepare("SELECT id FROM users WHERE role IN ('staff', 'chief', 'master')")
        .all()
        .map(({ id }) => id)
    : [];

  if (hasRetiredRoleSchema) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          name TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin', 'official', 'student')),
          memo TEXT DEFAULT '',
          realname TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          created_at TEXT,
          active INTEGER DEFAULT 1,
          affiliation TEXT DEFAULT '',
          access_revision INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users_new (id, email, name, role, memo, realname, phone, affiliation, created_at, active, access_revision)
          SELECT id, email, name,
                 CASE WHEN role IN ('staff', 'chief', 'master') THEN 'official' ELSE role END,
                 memo, realname, phone, affiliation, created_at, active, access_revision
          FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    const foreignKeyViolations = db.pragma("foreign_key_check");
    if (foreignKeyViolations.length > 0) {
      throw new Error("Auth account-role migration left invalid foreign-key references");
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS user_permission (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);
CREATE TABLE IF NOT EXISTS kiosk_device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('kiosk.queue.register', 'kiosk.registration.register')),
  token_hash TEXT UNIQUE,
  pairing_code_hash TEXT,
  pairing_code_expires_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paired_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kiosk_device_token_hash ON kiosk_device(token_hash);
CREATE INDEX IF NOT EXISTS idx_kiosk_device_pairing_code_hash ON kiosk_device(pairing_code_hash);`);

  // These administration features were briefly exposed as Official service grants
  // in the preview. Account & Access, Entry, Email/SMS, and the system logs are
  // Admin-only tools, so any stored grant for them is retired here.
  db.prepare(
    `DELETE FROM user_permission
  WHERE permission_key IN ('applications.manage', 'contacts.manage', 'entry.manage', 'messaging.operate', 'audit.view')`,
  ).run();

  const legacyBundleTableExists = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_permission_bundle'",
      )
      .get(),
  );

  // A normal legacy database has no grant tables. Clear rows as well when this
  // migration sees a partially upgraded database, so retired ranks always become
  // grant-free Officials instead of inheriting grants from an interrupted rollout.
  if (retiredRoleUserIds.length > 0) {
    const placeholders = retiredRoleUserIds.map(() => "?").join(",");
    db.transaction(() => {
      if (legacyBundleTableExists) {
        db.prepare(`DELETE FROM user_permission_bundle WHERE user_id IN (${placeholders})`).run(
          ...retiredRoleUserIds,
        );
      }
      db.prepare(`DELETE FROM user_permission WHERE user_id IN (${placeholders})`).run(
        ...retiredRoleUserIds,
      );
    })();
  }

  if (legacyBundleTableExists) {
    const rows = db
      .prepare(
        `
    SELECT b.user_id, b.bundle_key
    FROM user_permission_bundle b
    JOIN users u ON u.id = b.user_id
    WHERE u.role = 'official'
    ORDER BY b.user_id, b.bundle_key
  `,
      )
      .all();
    for (const { bundle_key: key } of rows) {
      if (!Object.hasOwn(LEGACY_PERMISSION_BUNDLES, key)) {
        throw new Error(`Unknown stored permission bundle: ${key}`);
      }
    }
    const insertPermission = db.prepare(
      "INSERT OR IGNORE INTO user_permission (user_id, permission_key) VALUES (?, ?)",
    );
    db.transaction(() => {
      for (const row of rows) {
        for (const permission of LEGACY_PERMISSION_BUNDLES[row.bundle_key]) {
          insertPermission.run(row.user_id, permission);
        }
      }
      db.exec("DROP TABLE user_permission_bundle");
    })();
  }

  for (const { permission_key: key } of db
    .prepare("SELECT DISTINCT permission_key FROM user_permission")
    .all()) {
    if (!PERMISSION_KEYS.includes(key)) throw new Error(`Unknown stored permission: ${key}`);
  }

  // Store one canonical source of grants. The UI deliberately exposes Course and
  // Score as all-or-nothing toggles, while tiered management supersedes the
  // matching operation grant. Rover's implied Course operation is not stored, so
  // a Rover-only account never gains Course deletion during this normalization.
  db.transaction(() => {
    const officialIds = db
      .prepare("SELECT id FROM users WHERE role = 'official' ORDER BY id")
      .all();
    const selectPermissions = db.prepare(
      "SELECT permission_key FROM user_permission WHERE user_id = ? ORDER BY permission_key",
    );
    const deletePermissions = db.prepare("DELETE FROM user_permission WHERE user_id = ?");
    const insertPermission = db.prepare(
      "INSERT INTO user_permission (user_id, permission_key) VALUES (?, ?)",
    );
    for (const { id } of officialIds) {
      const grants = selectPermissions.all(id).map(({ permission_key: key }) => key);
      const normalized = normalizeAccessGrants(grants);
      if (
        grants.length === normalized.length &&
        grants.every((key, index) => key === normalized[index])
      )
        continue;
      deletePermissions.run(id);
      for (const permission of normalized) insertPermission.run(id, permission);
    }
  })();

  // 관리자 토글 등 key/value 설정 저장소
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

  // 계정 신청 접수 기본값: 닫힘
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('applications_open', '0')").run();

  // 계정 신청 (승인 시 users로 이동 후 삭제). email UNIQUE로 1인 1신청 보장
  db.exec(`CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  realname TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  affiliation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);

  // Preserve legacy free-form contacts instead of dropping production data.
  // The new sidebar model uses ops_display(user_id), so old rows cannot be
  // losslessly mapped without an explicit admin decision.
  {
    const legacyOpsContacts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_contacts'")
      .get();
    const preservedOpsContacts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_contacts_legacy'")
      .get();
    if (legacyOpsContacts && !preservedOpsContacts) {
      db.exec("ALTER TABLE ops_contacts RENAME TO ops_contacts_legacy");
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS ops_display (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
)`);

  addColumn(db, "ops_display", "description TEXT NOT NULL DEFAULT ''");

  addColumn(db, "ops_display", "sort_order INTEGER NOT NULL DEFAULT 0");

  runMigrationOnce(db, "auth.ops_contact_sort_order.v1", () => {
    const rows = db.prepare("SELECT user_id FROM ops_display ORDER BY user_id").all();
    const update = db.prepare("UPDATE ops_display SET sort_order = ? WHERE user_id = ?");
    for (const [index, row] of rows.entries()) update.run(index, row.user_id);
  });

  db.exec("DELETE FROM ops_display WHERE user_id NOT IN (SELECT id FROM users)");

  db.pragma("foreign_keys = ON");

  runMigrationOnce(db, "auth.utc_timestamp_normalization.v1", () => {
    for (const [table, column] of [
      ["users", "created_at"],
      ["applications", "created_at"],
      ["applications", "updated_at"],
    ]) {
      normalizeTimestampColumn(db, table, column);
    }
  });

  // Bootstrap: ADMIN_EMAIL이 DB에 없으면 admin으로 등록
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

  if (ADMIN_EMAIL) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
    if (!existing) {
      db.prepare("INSERT INTO users (email, role) VALUES (?, 'admin')").run(ADMIN_EMAIL);
    }
  }

  return { ADMIN_EMAIL };
}
