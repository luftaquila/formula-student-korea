import crypto from "node:crypto";
import { assertCanonicalTeamReferences } from "./team-references.mjs";

export function normalizeSchemaSql(sql) {
  return String(sql || "").trim().replace(/\s+/g, " ")
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
  objectCount: 125,
  sha256: "1336208794493a2d46d703cbaa76ecd68f71f1fe6e1081817aef02aaf29a2554",
});

export function competitionSchemaContractDigest(contract) {
  return crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

const REQUIRED_COLUMNS = Object.freeze({
  competition_team: ["id", "year", "num", "univ", "name", "vehicle_type_id", "active", "created_at", "updated_at"],
  competition_vehicle_type: ["id", "year", "display_name", "color", "sort_order"],
  inspection: ["type", "name", "active"],
  sheet_answer: ["year", "team_num", "item_id", "value", "memo", "answer_updated_at", "answer_updated_by", "memo_updated_at", "memo_updated_by", "team_id"],
  record: ["name", "num", "univ", "team", "type", "result", "team_id"],
  score_manual: ["year", "team_num", "score_type", "team_id"],
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
  if (contract.length !== COMPETITION_SCHEMA_CONTRACT.objectCount
    || contractDigest !== COMPETITION_SCHEMA_CONTRACT.sha256) {
    incompatible.push(
      `complete-schema<contract:${contract.length}:${contractDigest}>`,
    );
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columns(db, table);
    if (!actual.length || required.some((column) => !actual.includes(column))) {
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
