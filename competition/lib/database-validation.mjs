import crypto from "node:crypto";
import { assertCanonicalTeamReferences } from "./team-references.mjs";

export function normalizeSchemaSql(sql) {
  return String(sql || "").trim().replace(/\s+/g, " ")
    // Traffic rebuilds the table through ALTER TABLE ... RENAME TO record;
    // SQLite persists that equivalent declaration with a quoted table name.
    .replace(/^CREATE TABLE "record"(?=\s*\()/i, "CREATE TABLE record")
    .replace(/(\byear\s+integer\s+not\s+null\s+default\s+)20\d{2}\b/gi, "$1<year>");
}

export function captureCompetitionSchemaContract(db) {
  return db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('table', 'view', 'index', 'trigger')
      AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all().map(({ type, name, sql }) => ({
    type,
    name,
    sha256: crypto.createHash("sha256").update(normalizeSchemaSql(sql)).digest("hex"),
  }));
}

export const COMPETITION_SCHEMA_CONTRACT = Object.freeze({
  objectCount: 131,
  sha256: "0e716bc37b1853ace4cc7b1ac464b4f3ba6488f3a4ee61d63b89a5f1ebca4279",
});

// Deployment validates a read-only snapshot before the runtime gets a chance
// to apply its idempotent schema additions. Accept only the exact immediately
// preceding contracts here; createRegistrationApp adds its two tables, while
// createScoreApp adds driver names and the qualified column or rebuilds the
// endurance table with its 0/1 constraint before serving. Any other schema
// still fails closed, and the next validation must match the current contract.
const MISSING_ENDURANCE_DRIVER_NAMES = Object.freeze(["driver1_name", "driver2_name"]);
const UPGRADABLE_SCHEMA_CONTRACTS = Object.freeze([
  Object.freeze({
    // Previous release: inspection items did not store deterministic rule references.
    objectCount: 131,
    sha256: "83a36e66e0d2786040e4b1cdfdc883fcc5ee64b3d90c3daf80c4669d1346e3f9",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({ sheet_template: Object.freeze(["rule_refs"]) }),
  }),
  Object.freeze({
    // Current rule-reference schema combined with the retired registration
    // called status and the pre-driver-name score schema.
    objectCount: 131,
    sha256: "d40378c37fdc159ab070fcf82eafef36c62fa5fd7cdbdd48cd79a8dd25634c90",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Current rule-reference schema before endurance driver names.
    objectCount: 131,
    sha256: "a442bea1ab762b97bc4238ca16d5d4e1dafc93f42bcb6f1455d2a0c90d4914e8",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Current rule-reference schema before Registration and driver names.
    objectCount: 125,
    sha256: "b43645cbccf07cfce4e1a7f92e848c9efc44ae6db90c1bacf5ad1de597da3401",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Current rule-reference schema before Registration, qualification, and driver names.
    objectCount: 125,
    sha256: "e977a972af1b1bc9f6bc6affaaa2e5f7f5432d3fd6009e85a6201134874bf6b4",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({
      score_endurance: Object.freeze(["qualified", ...MISSING_ENDURANCE_DRIVER_NAMES]),
    }),
  }),
  Object.freeze({
    // Current rule-reference schema with the previous unconstrained qualification column.
    objectCount: 125,
    sha256: "2a998ecd02b336cc525ecf03341ecead2ea97899ae83c3913710ade9136d1f45",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Previous release: endurance records did not store driver names.
    objectCount: 131,
    sha256: "6d50f0c70d2411bdbf36adee7f4f399bd13a409cfa06848ed0139f2dc52cad60",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Previous release: Traffic used invalidated/result=-1 instead of status.
    objectCount: 131,
    sha256: "66e3d7c77e67e20986753a75d1aba69a614bb34130dcc4e31c1275011bbac8ad",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({
      record: Object.freeze(["status"]),
      score_endurance: MISSING_ENDURANCE_DRIVER_NAMES,
    }),
  }),
  Object.freeze({
    // registration_queue still carrying the retired 'called' status and its
    // called_at column; createRegistrationApp rebuilds the table before serving.
    objectCount: 131,
    sha256: "14bcbdd8cd48d0d126f61d8e9a3aaa280326221e6692a989c00ddec8e9ffc216",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    // Same registration predecessor combined with the previous Traffic schema.
    objectCount: 131,
    sha256: "6f97860d38a0b4f04adda2f2d0e92d65feb029386540c12e24e38ab9be5c1ce8",
    allowedMissingTables: Object.freeze([]),
    allowedMissingColumns: Object.freeze({
      record: Object.freeze(["status"]),
      score_endurance: MISSING_ENDURANCE_DRIVER_NAMES,
    }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "06bac65306e9aed00a94e9a96bfb4a6f3e0c9fe49cdf2b013f34e3fac6b8d394",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "d15402064ce944ff614933980223c52aaf33392f26b2d5d29776aae69967fd93",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({
      score_endurance: Object.freeze(["qualified", ...MISSING_ENDURANCE_DRIVER_NAMES]),
    }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "bbfed20876a4642ecc6759441ac84d6c1c28e9b21689a8fafb2cfe4b44f400b4",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({ score_endurance: MISSING_ENDURANCE_DRIVER_NAMES }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "b625e28d3c070bc9fbb29265234c37678a7b2624e7c03d3db75c0d3e8fec6afc",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({
      record: Object.freeze(["status"]),
      score_endurance: MISSING_ENDURANCE_DRIVER_NAMES,
    }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "1336208794493a2d46d703cbaa76ecd68f71f1fe6e1081817aef02aaf29a2554",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({
      record: Object.freeze(["status"]),
      score_endurance: Object.freeze(["qualified", ...MISSING_ENDURANCE_DRIVER_NAMES]),
    }),
  }),
  Object.freeze({
    objectCount: 125,
    sha256: "f5d3df22739e93f7c3231d6dede2b7a5cbe39ca71158bd4fe9a5d60eeed44b7c",
    allowedMissingTables: Object.freeze(["registration_queue", "registration_settings"]),
    allowedMissingColumns: Object.freeze({
      record: Object.freeze(["status"]),
      score_endurance: MISSING_ENDURANCE_DRIVER_NAMES,
    }),
  }),
]);

export function competitionSchemaContractDigest(contract) {
  return crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

const REQUIRED_COLUMNS = Object.freeze({
  competition_team: ["id", "year", "num", "univ", "name", "vehicle_type_id", "active", "created_at", "updated_at"],
  competition_vehicle_type: ["id", "year", "display_name", "color", "sort_order"],
  registration_queue: ["id", "team_id", "phone", "status", "notified", "notify_claimed_at", "registered_at", "finished_at"],
  registration_settings: ["year", "open", "sms", "notify_rank", "updated_at"],
  inspection: ["type", "name", "active"],
  sheet_template: ["id", "year", "level", "parent_id", "sort_order", "name", "answer_type", "remarks", "unit", "pdf_include", "excluded_types", "field_key", "calculation", "rule_refs"],
  sheet_answer: ["year", "team_num", "item_id", "value", "memo", "answer_updated_at", "answer_updated_by", "memo_updated_at", "memo_updated_by", "team_id"],
  record: ["name", "num", "univ", "team", "type", "result", "status", "team_id"],
  score_manual: ["year", "team_num", "score_type", "team_id"],
  score_endurance: ["year", "team_num", "qualified", "team_id", "driver1_name", "driver2_name"],
  session: ["id", "year"],
  submission: ["id", "session_id", "team_num", "storage_dir", "team_id"],
  submission_file: ["id", "submission_id", "stored_name"],
  scheduled_notification: ["id", "session_id", "scheduled_at", "sent"],
});

export const COMPETITION_RUNTIME_SCHEMA = Object.freeze(
  Object.keys(REQUIRED_COLUMNS).map((name) => Object.freeze({ type: "table", name })),
);

function columns(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map(({ name }) => name);
}

function fail(entries) {
  throw new Error(`missing or incompatible Competition runtime schema: ${entries.join(", ")}`);
}

export function assertCompetitionSchema(db) {
  const incompatible = [];
  const contract = captureCompetitionSchemaContract(db);
  const contractDigest = competitionSchemaContractDigest(contract);
  const currentContract = contract.length === COMPETITION_SCHEMA_CONTRACT.objectCount
    && contractDigest === COMPETITION_SCHEMA_CONTRACT.sha256;
  const upgradeContract = UPGRADABLE_SCHEMA_CONTRACTS.find(({ objectCount, sha256 }) => (
    contract.length === objectCount && contractDigest === sha256
  ));
  if (!currentContract && !upgradeContract) {
    incompatible.push(
      `complete-schema<contract:${contract.length}:${contractDigest}>`,
    );
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columns(db, table);
    const allowedMissingTables = upgradeContract?.allowedMissingTables || [];
    if (!actual.length && allowedMissingTables.includes(table)) continue;
    const allowedMissing = upgradeContract?.allowedMissingColumns[table] || [];
    if (!actual.length || required.some((column) => (
      !actual.includes(column) && !allowedMissing.includes(column)
    ))) {
      incompatible.push(`${table}<table:${actual.length ? "definition" : "missing"}>`);
    }
  }
  const teamColumns = columns(db, "competition_team");
  for (const removed of ["version", "deleted_at"]) {
    if (teamColumns.includes(removed)) incompatible.push(`competition_team<table:removed-${removed}>`);
  }
  const answerColumns = columns(db, "sheet_answer");
  for (const removed of ["answer_version", "memo_version"]) {
    if (answerColumns.includes(removed)) incompatible.push(`sheet_answer<table:removed-${removed}>`);
  }
  for (const removedTable of [
    "competition_year_version", "competition_migration_identity", "team_status",
    "entry_active_revision", "lifecycle_outbox", "team_renumber_file_work", "current_legacy",
  ]) {
    if (columns(db, removedTable).length) incompatible.push(`${removedTable}<table:unexpected>`);
  }
  const inactiveTeamView = db.prepare(
    "SELECT type FROM sqlite_master WHERE name = 'competition_inactive_team'",
  ).get();
  if (inactiveTeamView?.type !== "view") incompatible.push("competition_inactive_team<view:missing>");

  if (columns(db, "score_endurance").includes("qualified")) {
    const invalidQualification = db.prepare(`
      SELECT 1 FROM score_endurance
      WHERE qualified IS NULL OR qualified NOT IN (0, 1)
      LIMIT 1
    `).get();
    if (invalidQualification) incompatible.push("score_endurance<qualified-domain>");
  }

  const scheduledForeignKeys = db.pragma("foreign_key_list('scheduled_notification')");
  if (!scheduledForeignKeys.some((foreignKey) => foreignKey.table === "session" && foreignKey.from === "session_id")) {
    incompatible.push("scheduled_notification<table:definition>");
  }

  const unexpectedExecutable = db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%'
      AND NOT (type = 'view' AND name = 'competition_inactive_team')
      AND NOT (type = 'trigger' AND name LIKE 'trg_%')
  `).all();
  for (const object of unexpectedExecutable) incompatible.push(`${object.name}<${object.type}:unexpected>`);
  if (incompatible.length) fail(incompatible);
  return true;
}

export function validateCompetitionDatabase(db) {
  db.pragma("query_only = ON");
  assertCompetitionSchema(db);
  const integrity = db.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.slice(0, 20))}`);
  }
  const foreignKeyErrors = db.pragma("foreign_key_check");
  if (foreignKeyErrors.length) {
    throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyErrors.slice(0, 20))}`);
  }
  assertCanonicalTeamReferences(db);
  return true;
}
