import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupTestEnv, TRUST_JWT } from "../helpers/test-utils.mjs";
import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { createMissionV2Store } from "../../course/lib/mission-v2.mjs";

setupTestEnv();
const { createCompetitionApp } = await import("../../competition/index.mjs");
const {
  COMPETITION_SCHEMA_CONTRACT,
  COMPETITION_RUNTIME_SCHEMA,
  captureCompetitionSchemaContract,
  competitionSchemaContractDigest,
} = await import("../../competition/lib/database-validation.mjs");

const require = createRequire(import.meta.url);
const Database = require("../../competition/node_modules/better-sqlite3");
const validator = path.resolve("scripts/lib/competition-uploads.sh");
const databaseValidator = path.resolve("competition/scripts/validate-database.mjs");
const supportDatabaseValidator = path.resolve("competition/scripts/validate-support-database.mjs");
const supportAppCreators = {
  auth: (await import("../../auth/index.mjs")).createAuthApp,
  calendar: (await import("../../calendar/index.mjs")).createCalendarApp,
  course: (await import("../../course/index.mjs")).createCourseApp,
  email: (await import("../../email/index.mjs")).createEmailApp,
};
const roots = [];
const sqliteAvailable = spawnSync("sqlite3", ["--version"]).status === 0;
const zipAvailable = spawnSync("zip", ["-v"]).status === 0;
const unzipAvailable = spawnSync("unzip", ["-v"]).status === 0;
const operationalScriptsAvailable = sqliteAvailable && zipAvailable && unzipAvailable;
const CURRENT_YEAR = currentCompetitionYear();

after(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-backup-artifacts-"));
  roots.push(root);
  const dbPath = path.join(root, "competition.db");
  const uploads = path.join(root, "uploads");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE submission (
      id INTEGER PRIMARY KEY,
      storage_dir TEXT
    );
    CREATE TABLE submission_file (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL,
      stored_name TEXT NOT NULL
    );
    INSERT INTO submission VALUES (11, '1/team-7/11');
    INSERT INTO submission_file VALUES (21, 11, 'stored.pdf');
  `);
  db.close();
  const stored = path.join(uploads, "1", "team-7", "11", "stored.pdf");
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, "fixture");
  return { root, dbPath, uploads, stored };
}

function validate(dbPath, uploads) {
  return spawnSync("bash", [
    "-c",
    'source "$1"; validate_competition_uploads "$2" "$3"',
    "competition-upload-validator",
    validator,
    dbPath,
    uploads,
  ], { encoding: "utf8" });
}

function validateMigrationReport(report) {
  return spawnSync("bash", [
    "-c",
    'source "$1"; validate_competition_migration_report "$2"',
    "competition-report-validator",
    validator,
    report,
  ], { encoding: "utf8" });
}

function validateDatabase(dbPath) {
  return spawnSync(process.execPath, [databaseValidator, dbPath], { encoding: "utf8" });
}

function validateSupportDatabase(service, dbPath) {
  return spawnSync(process.execPath, [supportDatabaseValidator, service, dbPath], { encoding: "utf8" });
}

function createPendingCourseMission(dbPath) {
  const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
  const now = new Date().toISOString();
  const courseId = Number(created.db.prepare(
    "INSERT INTO course (name,created_at,updated_at) VALUES ('Validator mission',?,?)",
  ).run(now, now).lastInsertRowid);
  const coneId = Number(created.db.prepare(`INSERT INTO cone
    (course_id,lat,lng,alt,side,created_at,updated_at) VALUES (?,35,126,NULL,'left',?,?)`)
    .run(courseId, now, now).lastInsertRowid);
  const store = createMissionV2Store(created.db);
  const mission = store.createMission({
    courseId,
    items: [{ cone_id: coneId, lat: 35, lng: 126, alt: null, side: "left" }],
  });
  const issued = store.issueCommand({
    missionId: mission.id,
    action: "start",
    expectedPlanHash: mission.plan_hash,
    expectedOccurrenceRevision: mission.occurrence_revision,
    targetBootId: "validator-boot",
  });
  created.db.close();
  return { mission, commandId: issued.command.id };
}

function writeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

function scriptProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-operational-scripts-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  for (const name of ["backup.sh", "restore.sh"]) {
    fs.copyFileSync(path.resolve("scripts", name), path.join(root, "scripts", name));
  }
  fs.copyFileSync(validator, path.join(root, "scripts", "lib", "competition-uploads.sh"));
  fs.mkdirSync(path.join(root, "competition", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "competition", "lib"), { recursive: true });
  for (const name of ["validate-database.mjs", "validate-support-database.mjs"]) {
    fs.copyFileSync(path.resolve("competition", "scripts", name), path.join(root, "competition", "scripts", name));
  }
  for (const name of ["database-validation.mjs", "support-database-validation.mjs", "team-references.mjs"]) {
    fs.copyFileSync(path.resolve("competition", "lib", name), path.join(root, "competition", "lib", name));
  }
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.copyFileSync(path.resolve("shared", "competition-year.mjs"), path.join(root, "shared", "competition-year.mjs"));
  fs.symlinkSync(path.resolve("competition/node_modules"), path.join(root, "competition", "node_modules"), "dir");
  return root;
}

function createSupportDatabases(root, { archive = false } = {}) {
  for (const [name, createApp] of Object.entries(supportAppCreators)) {
    const dbPath = archive
      ? path.join(root, "db", `${name}.db`)
      : path.join(root, name, "data", `${name}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const created = createApp({ dbPath, skipStaticValidation: true });
    created.db.close();
  }
}

function writeRequiredDatabaseManifest(root) {
  fs.writeFileSync(path.join(root, "db", "required-databases.txt"), [
    "format=fsk-required-databases-v1",
    "competition.db",
    "auth.db",
    "calendar.db",
    "course.db",
    "email.db",
    "",
  ].join("\n"));
}

function createCompetitionUnit(dbPath, uploads, marker = "artifact") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  const created = createCompetitionApp({
    dbPath,
    uploadRoot: uploads,
    skipStaticValidation: true,
    validateUser: TRUST_JWT,
  });
  created.close();
  fs.writeFileSync(path.join(uploads, `${marker}.txt`), marker);
}

function restoreRetiredCalledStatus(dbPath) {
  const writer = new Database(dbPath);
  writer.exec(`
    DROP TABLE registration_queue;
    CREATE TABLE registration_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES competition_team(id),
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK(status IN ('waiting','called','done','canceled')),
      notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1,2)),
      notify_claimed_at TEXT,
      registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      called_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX idx_registration_queue_status ON registration_queue(status, id);
    CREATE INDEX idx_registration_queue_team ON registration_queue(team_id, status, id);
    CREATE INDEX idx_registration_queue_finished
      ON registration_queue(finished_at) WHERE finished_at IS NOT NULL;
    CREATE UNIQUE INDEX idx_registration_queue_active_team
      ON registration_queue(team_id) WHERE status IN ('waiting','called');
  `);
  const teamId = writer.prepare("SELECT id FROM competition_team ORDER BY id LIMIT 1").get()?.id;
  writer.prepare(`
    INSERT INTO registration_queue (team_id, phone, status, called_at)
    VALUES (?, '01012345678', 'called', '2026-08-20T00:00:00.000Z')
  `).run(teamId);
  writer.close();
  return teamId;
}

function restoreLegacyTrafficRecordSchema(dbPath) {
  const writer = new Database(dbPath);
  writer.exec(`
    DROP TABLE record;
    CREATE TABLE record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      legacy_rowid INTEGER NOT NULL,
      time TEXT NOT NULL,
      num INTEGER NOT NULL,
      univ TEXT NOT NULL,
      team TEXT NOT NULL,
      type TEXT NOT NULL,
      result INTEGER NOT NULL,
      detail TEXT,
      cones INTEGER DEFAULT 0,
      oc INTEGER DEFAULT 0,
      invalidated INTEGER DEFAULT 0,
      scoreboard INTEGER DEFAULT 1,
      team_id INTEGER
    );
    CREATE UNIQUE INDEX idx_record_name_legacy_rowid ON record(name, legacy_rowid);
    CREATE INDEX idx_record_name_num ON record(name, num);
    CREATE INDEX idx_record_team_id ON record(team_id);
  `);
  writer.close();
}

function removeRegistrationSchema(dbPath) {
  const writer = new Database(dbPath);
  writer.exec(`
    DROP TABLE registration_queue;
    DROP TABLE registration_settings;
  `);
  writer.close();
}

function removeQualifiedCheckConstraint(dbPath) {
  const writer = new Database(dbPath);
  const tableSql = writer.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'score_endurance'",
  ).get().sql;
  const unconstrainedSql = tableSql.replace(" CHECK(qualified IN (0, 1))", "");
  assert.notEqual(unconstrainedSql, tableSql);
  const columns = writer.pragma("table_info('score_endurance')").map(({ name }) => name).join(", ");
  const dependentObjects = writer.prepare(`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'score_endurance' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all().map(({ sql }) => sql);
  writer.transaction(() => {
    writer.exec("ALTER TABLE score_endurance RENAME TO score_endurance_with_qualified_check");
    writer.exec(unconstrainedSql);
    writer.exec(`
      INSERT INTO score_endurance (${columns})
      SELECT ${columns} FROM score_endurance_with_qualified_check;
      DROP TABLE score_endurance_with_qualified_check;
    `);
    for (const sql of dependentObjects) writer.exec(sql);
  })();
  writer.close();
}

function addReferencedUpload(dbPath, uploads) {
  const created = createCompetitionApp({
    dbPath,
    uploadRoot: uploads,
    skipStaticValidation: true,
    validateUser: TRUST_JWT,
  });
  const team = created.teams.createTeam(CURRENT_YEAR, {
    number: 7,
    university: "Artifact University",
    name: "Artifact Team",
  });
  const sessionId = Number(created.db.prepare(`
    INSERT INTO session (name, start_at, end_at, late_end_at, created_by, year)
    VALUES ('Artifact session', ?, ?, ?, 'admin', ?)
  `).run(
    `${CURRENT_YEAR}-01-01`, `${CURRENT_YEAR}-01-02`, `${CURRENT_YEAR}-01-03`, CURRENT_YEAR,
  ).lastInsertRowid);
  const submissionId = Number(created.db.prepare(`
    INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, storage_dir)
    VALUES (?, ?, 'student', ?, 'pending')
  `).run(sessionId, team.number, `${CURRENT_YEAR}-01-01`).lastInsertRowid);
  const storageDir = `${sessionId}/team-${team.id}/${submissionId}`;
  created.db.prepare("UPDATE submission SET storage_dir = ? WHERE id = ?").run(storageDir, submissionId);
  created.db.prepare(`
    INSERT INTO submission_file (submission_id, original_name, stored_name, size)
    VALUES (?, 'stored.pdf', 'stored.pdf', 7)
  `).run(submissionId);
  created.close();

  const stored = path.join(uploads, storageDir, "stored.pdf");
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, "fixture");
  return { storageDir, stored, firstComponent: String(sessionId) };
}

function replaceFirstUploadDirectoryWithInternalSymlink(uploads, firstComponent) {
  const linked = path.join(uploads, firstComponent);
  const realName = `real-${firstComponent}`;
  fs.renameSync(linked, path.join(uploads, realName));
  fs.symlinkSync(realName, linked, "dir");
}

function createMinimalCompetitionUnit(dbPath, uploads) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  const migrationId = "1189207e-24f8-4b19-920d-e5d4f65f98c5";
  const completedAt = "2026-08-11T03:00:00.000Z";
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE competition_migration_identity (
      singleton INTEGER PRIMARY KEY,
      migration_id TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE submission (
      id INTEGER PRIMARY KEY,
      storage_dir TEXT
    );
    CREATE TABLE submission_file (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL,
      stored_name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO competition_migration_identity VALUES (1, ?, ?)")
    .run(migrationId, completedAt);
  db.close();
  fs.writeFileSync(`${dbPath}.migration.json`, `${JSON.stringify({
    schemaVersion: 2,
    migrationId,
    completedAt,
    target: { sha256: "a".repeat(64) },
  }, null, 2)}\n`);
}

function treeHash(root) {
  const hash = crypto.createHash("sha256");
  function visit(target, relative) {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      hash.update(`d:${relative}\n`);
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), path.join(relative, name));
    } else {
      hash.update(`f:${relative}:${stat.mode}\n`);
      hash.update(fs.readFileSync(target));
    }
  }
  visit(root, ".");
  return hash.digest("hex");
}

function removeInspectionActiveColumn(dbPath) {
  const db = new Database(dbPath);
  db.exec("ALTER TABLE inspection DROP COLUMN active");
  db.close();
}

function removeScheduledNotificationForeignKey(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE scheduled_notification RENAME TO scheduled_notification_with_fk;
    CREATE TABLE scheduled_notification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      sent_recipients TEXT DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO scheduled_notification
    SELECT * FROM scheduled_notification_with_fk;
    DROP TABLE scheduled_notification_with_fk;
    CREATE INDEX idx_sn_pending ON scheduled_notification(sent, scheduled_at);
    CREATE INDEX idx_sn_session_sent ON scheduled_notification(session_id, sent);
  `);
  db.close();
}

function addUnexpectedExecutableTrigger(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TRIGGER destructive_session_insert
    AFTER INSERT ON session
    BEGIN
      DELETE FROM scheduled_notification;
    END
  `);
  db.close();
}

function createNamedButMalformedAuthDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (x TEXT);
    CREATE TABLE settings (x TEXT);
    CREATE TABLE applications (x TEXT);
    CREATE TABLE ops_display (x TEXT);
    CREATE TABLE logs (x TEXT);
    CREATE TABLE schema_migrations (x TEXT);
  `);
  db.close();
}

function addInvalidCourseMissionState(dbPath) {
  const { commandId } = createPendingCourseMission(dbPath);
  const db = new Database(dbPath);
  const payload = JSON.parse(db.prepare(
    "SELECT payload_json FROM mission_command WHERE id=?",
  ).get(commandId).payload_json);
  payload.waypoints[0].lat += 1;
  db.prepare("UPDATE mission_command SET payload_json=? WHERE id=?")
    .run(JSON.stringify(payload), commandId);
  db.close();
}

function createRestoreFixture({
  minimalDatabase = false,
  missingRuntimeColumn = false,
  missingRequiredConstraint = false,
  unexpectedExecutableTrigger = false,
  corruptSupportDatabase = false,
  malformedNamedSupportSchema = false,
  invalidCourseMissionState = false,
  missingSupportDatabase = null,
  symlinkCompetitionDatabase = false,
  intermediateUploadSymlink = false,
} = {}) {
  const root = scriptProject();
  const archiveRoot = path.join(root, "archive");
  const createUnit = minimalDatabase ? createMinimalCompetitionUnit : createCompetitionUnit;
  createUnit(
    path.join(archiveRoot, "db", "competition.db"),
    path.join(archiveRoot, "competition", "uploads"),
    "restored upload",
  );
  if (intermediateUploadSymlink) {
    const uploads = path.join(archiveRoot, "competition", "uploads");
    const referenced = addReferencedUpload(path.join(archiveRoot, "db", "competition.db"), uploads);
    replaceFirstUploadDirectoryWithInternalSymlink(uploads, referenced.firstComponent);
  }
  createSupportDatabases(archiveRoot, { archive: true });
  writeRequiredDatabaseManifest(archiveRoot);
  if (missingRuntimeColumn) {
    removeInspectionActiveColumn(path.join(archiveRoot, "db", "competition.db"));
  }
  if (missingRequiredConstraint) {
    removeScheduledNotificationForeignKey(path.join(archiveRoot, "db", "competition.db"));
  }
  if (unexpectedExecutableTrigger) {
    addUnexpectedExecutableTrigger(path.join(archiveRoot, "db", "competition.db"));
  }
  if (corruptSupportDatabase) {
    fs.writeFileSync(path.join(archiveRoot, "db", "auth.db"), "not a sqlite database");
  }
  if (malformedNamedSupportSchema) {
    createNamedButMalformedAuthDatabase(path.join(archiveRoot, "db", "auth.db"));
  }
  if (invalidCourseMissionState) {
    addInvalidCourseMissionState(path.join(archiveRoot, "db", "course.db"));
  }
  if (missingSupportDatabase) {
    fs.rmSync(path.join(archiveRoot, "db", `${missingSupportDatabase}.db`), { force: true });
  }
  if (symlinkCompetitionDatabase) {
    const databasePath = path.join(archiveRoot, "db", "competition.db");
    const outsideDatabase = path.join(root, "outside-competition.db");
    fs.renameSync(databasePath, outsideDatabase);
    fs.symlinkSync(outsideDatabase, databasePath);
  }
  const zipPath = path.join(root, "restore.zip");
  const preserveSymlinks = symlinkCompetitionDatabase || intermediateUploadSymlink;
  const zipped = spawnSync("zip", [preserveSymlinks ? "-qry" : "-qr", zipPath, "."], { cwd: archiveRoot, encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);

  const liveData = path.join(root, "competition", "data");
  fs.mkdirSync(path.join(liveData, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(liveData, "competition.db"), "live database");
  fs.writeFileSync(path.join(liveData, "competition.db.migration.json"), "live report");
  fs.writeFileSync(path.join(liveData, "uploads", "live.txt"), "live upload");
  const liveAuth = path.join(root, "auth", "data", "auth.db");
  fs.mkdirSync(path.dirname(liveAuth), { recursive: true });
  fs.writeFileSync(liveAuth, "live auth database");

  const fakeBin = path.join(root, "fake-bin");
  const podmanLog = path.join(root, "podman.log");
  writeExecutable(path.join(fakeBin, "podman"), `#!/bin/sh
if [ -n "\${PODMAN_LOG:-}" ]; then printf '%s\\n' "$*" >> "$PODMAN_LOG"; fi
if [ "\${PODMAN_MODE:-fail}" = "partial" ]; then
  case " $* " in
    *" down "*) exit 0 ;;
    *" ps "*) printf "competition\\n"; exit 0 ;;
  esac
fi
if [ "\${PODMAN_MODE:-fail}" = "success" ]; then
  case " $* " in
    *" down "*|*" ps "*|*" up "*|*" restart "*) exit 0 ;;
  esac
fi
exit 42
`);
  return { root, zipPath, liveData, liveAuth, fakeBin, podmanLog };
}

function createBackupFixture({
  minimalDatabase = false,
  missingRuntimeColumn = false,
  missingRequiredConstraint = false,
  unexpectedExecutableTrigger = false,
  invalidSupportSchema = false,
  malformedNamedSupportSchema = false,
  invalidCourseMissionState = false,
  missingSupportDatabase = null,
  fileBrowserFiles = false,
  intermediateUploadSymlink = false,
} = {}) {
  const root = scriptProject();
  const createUnit = minimalDatabase ? createMinimalCompetitionUnit : createCompetitionUnit;
  createUnit(
    path.join(root, "competition", "data", "competition.db"),
    path.join(root, "competition", "data", "uploads"),
    "backup upload",
  );
  if (intermediateUploadSymlink) {
    const uploads = path.join(root, "competition", "data", "uploads");
    const referenced = addReferencedUpload(path.join(root, "competition", "data", "competition.db"), uploads);
    replaceFirstUploadDirectoryWithInternalSymlink(uploads, referenced.firstComponent);
  }
  createSupportDatabases(root);
  if (missingRuntimeColumn) {
    removeInspectionActiveColumn(path.join(root, "competition", "data", "competition.db"));
  }
  if (missingRequiredConstraint) {
    removeScheduledNotificationForeignKey(path.join(root, "competition", "data", "competition.db"));
  }
  if (unexpectedExecutableTrigger) {
    addUnexpectedExecutableTrigger(path.join(root, "competition", "data", "competition.db"));
  }
  if (invalidSupportSchema) {
    const authPath = path.join(root, "auth", "data", "auth.db");
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.rmSync(authPath, { force: true });
    const auth = new Database(authPath);
    auth.exec("CREATE TABLE wrong_service_schema (id INTEGER PRIMARY KEY)");
    auth.close();
  }
  if (malformedNamedSupportSchema) {
    createNamedButMalformedAuthDatabase(path.join(root, "auth", "data", "auth.db"));
  }
  if (invalidCourseMissionState) {
    addInvalidCourseMissionState(path.join(root, "course", "data", "course.db"));
  }
  if (missingSupportDatabase) {
    fs.rmSync(path.join(root, missingSupportDatabase, "data", `${missingSupportDatabase}.db`), { force: true });
  }
  let dbPath;
  let generationFile;
  if (fileBrowserFiles) {
    dbPath = path.join(root, "filebrowser", "data", "database.db");
    generationFile = path.join(root, "filebrowser", "data", "files", "generation.txt");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "private external database");
    fs.mkdirSync(path.dirname(generationFile), { recursive: true });
    fs.writeFileSync(generationFile, "generation-one");
  }
  const destination = path.join(root, "destination");
  const fakeBin = path.join(root, "fake-bin");
  const podmanLog = path.join(root, "podman.log");
  writeExecutable(path.join(fakeBin, "date"), "#!/bin/sh\nprintf '20260811-123456\\n'\n");
  writeExecutable(path.join(fakeBin, "podman"), `#!/bin/sh
if [ -n "\${PODMAN_LOG:-}" ]; then printf '%s\\n' "$*" >> "$PODMAN_LOG"; fi
exit 1
`);
  return { root, destination, fakeBin, podmanLog, dbPath, generationFile };
}

function runBackup({ root, destination, fakeBin, ...fixture }, extraEnv = {}) {
  return spawnSync("bash", [path.join(root, "scripts", "backup.sh"), destination], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FSK_BACKUP_ASSUME_QUIESCED: "1",
      PODMAN_LOG: fixture.podmanLog,
      FILEBROWSER_DB: fixture.dbPath,
      FILEBROWSER_GENERATION_FILE: fixture.generationFile,
      LEGACY_DB: fixture.dbPath,
      LEGACY_UPLOADS: fixture.uploads,
      ...extraEnv,
    },
  });
}

describe("Competition backup/restore artifact validation", () => {
  it("accepts a complete referenced upload tree", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const result = validate(dbPath, uploads);
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a missing individual referenced upload", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads, stored } = fixture();
    fs.unlinkSync(stored);
    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /submission_file 21/);
  });

  it("rejects a referenced path that escapes through a parent symlink", { skip: !sqliteAvailable }, () => {
    const { root, dbPath, uploads } = fixture();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "stored.pdf"), "outside");
    fs.symlinkSync(outside, path.join(uploads, "escape"));
    const db = new Database(dbPath);
    db.prepare("UPDATE submission SET storage_dir = 'escape'").run();
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
  });

  it("rejects an intermediate symlink that resolves inside the upload root", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    replaceFirstUploadDirectoryWithInternalSymlink(uploads, "1");

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
  });

  it("rejects an intermediate storage-directory symlink without file rows", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.close();
    replaceFirstUploadDirectoryWithInternalSymlink(uploads, "1");

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
  });

  it("rejects a final referenced-file symlink", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads, stored } = fixture();
    const realFile = path.join(path.dirname(stored), "real.pdf");
    fs.renameSync(stored, realFile);
    fs.symlinkSync("real.pdf", stored, "file");

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
  });

  it("rejects invalid submission storage metadata even when there are no file rows", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.prepare("UPDATE submission SET storage_dir = '   '").run();
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /검증할 수 없는 제출 파일 메타데이터/);
  });

  it("rejects a vertical-tab-only submission storage directory with no file rows", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.prepare("UPDATE submission SET storage_dir = ?").run("\u000b");
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /검증할 수 없는 제출 파일 메타데이터/);
  });

  it("matches JavaScript trim for whitespace-only submission storage directories", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const ecmaScriptWhitespace = [
      "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u00a0", "\u1680",
      "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007",
      "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
    ].join("");
    assert.equal(ecmaScriptWhitespace.trim(), "");
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.prepare("UPDATE submission SET storage_dir = ?").run(ecmaScriptWhitespace);
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /검증할 수 없는 제출 파일 메타데이터/);
  });

  it("rejects a symbolic-link uploads root when there are no file rows", { skip: !sqliteAvailable }, () => {
    const { root, dbPath, uploads } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.close();
    fs.rmSync(uploads, { recursive: true, force: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "must-remain.txt"), "kept");
    fs.symlinkSync(outside, uploads, "dir");

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
    assert.equal(fs.readFileSync(path.join(outside, "must-remain.txt"), "utf8"), "kept");
  });

  it("rejects an uploads root beneath a symbolic-link ancestor with no file rows", { skip: !sqliteAvailable }, () => {
    const { root, dbPath } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.close();
    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    const realUploads = path.join(realParent, "uploads");
    fs.mkdirSync(realUploads, { recursive: true });
    fs.symlinkSync(realParent, linkedParent, "dir");

    const result = validate(dbPath, path.join(linkedParent, "uploads"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
  });

  it("rejects an absolute submission storage directory even when there are no file rows", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads } = fixture();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM submission_file").run();
    db.prepare("UPDATE submission SET storage_dir = '/abs'").run();
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /검증할 수 없는 제출 파일 메타데이터/);
  });

  it("rejects a stored name containing a path component", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads, stored } = fixture();
    const nested = path.join(path.dirname(stored), "nested", "stored.pdf");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "fixture");
    const db = new Database(dbPath);
    db.prepare("UPDATE submission_file SET stored_name = 'nested/stored.pdf'").run();
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /검증할 수 없는 제출 파일 메타데이터/);
  });

  it("rejects a submission storage directory that normalizes to the upload root", { skip: !sqliteAvailable }, () => {
    const { dbPath, uploads, stored } = fixture();
    fs.writeFileSync(path.join(uploads, "file.pdf"), "fixture");
    const db = new Database(dbPath);
    db.prepare("UPDATE submission SET storage_dir = '.'").run();
    db.prepare("UPDATE submission_file SET stored_name = 'file.pdf'").run();
    db.close();

    const result = validate(dbPath, uploads);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /업로드 루트 자체입니다: submission 11/);
    assert.equal(fs.existsSync(stored), true);
  });

  it("treats a well-formed migration report as audit-only metadata", { skip: !sqliteAvailable }, () => {
    const { root } = fixture();
    const migrationId = "1189207e-24f8-4b19-920d-e5d4f65f98c5";
    const completedAt = "2026-08-11T03:00:00.000Z";
    const report = path.join(root, "competition's.db.migration.json");
    fs.writeFileSync(report, `${JSON.stringify({
      schemaVersion: 1,
      migrationId,
      completedAt,
      target: { sha256: "a".repeat(64) },
    }, null, 2)}\n`);

    assert.equal(validateMigrationReport(report).status, 0);
    fs.writeFileSync(report, `${JSON.stringify({
      schemaVersion: 1,
      migrationId: "fba15a30-93ca-4f8a-a886-5bbcb682d0ac",
      completedAt,
      target: { sha256: "a".repeat(64) },
    }, null, 2)}\n`);
    assert.equal(validateMigrationReport(report).status, 0);
    fs.writeFileSync(report, "{}\n");
    const malformed = validateMigrationReport(report);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /형식이 올바르지 않습니다/);
  });

  it("upgrades a registration queue that still carries the retired called status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-called-upgrade-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    const boot = () => createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });

    let created = boot();
    created.teams.createTeam(currentCompetitionYear(), { number: 41, university: "Upgrade University", name: "Upgrade Team" });
    created.close();
    restoreRetiredCalledStatus(dbPath);

    // A deployment snapshot taken before the upgrade must still validate: the
    // shipped contract is listed as upgradable, and the runtime rebuilds on boot.
    const predecessor = validateDatabase(dbPath);
    assert.equal(predecessor.status, 0, predecessor.stderr);

    created = boot();
    try {
      const columns = created.db.prepare("PRAGMA table_info(registration_queue)").all().map(({ name }) => name);
      assert.equal(columns.includes("called_at"), false);
      const row = created.db.prepare("SELECT id, status FROM registration_queue").get();
      assert.deepEqual(row, { id: 1, status: "waiting" }, "a called row becomes waiting again");
      const activeIndex = created.db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_registration_queue_active_team'",
      ).get().sql;
      assert.match(activeIndex, /WHERE status = 'waiting'/);
    } finally {
      created.close();
    }

    // The rebuild has to leave the exact DDL a fresh database produces, otherwise
    // the next deployment validation would reject the upgraded database.
    const reader = new Database(dbPath, { readonly: true });
    const upgraded = captureCompetitionSchemaContract(reader);
    reader.close();
    assert.equal(upgraded.length, COMPETITION_SCHEMA_CONTRACT.objectCount);
    assert.equal(competitionSchemaContractDigest(upgraded), COMPETITION_SCHEMA_CONTRACT.sha256);
    assert.equal(validateDatabase(dbPath).status, 0);
  });

  it("accepts a Traffic status upgrade whose renamed record table is quoted by SQLite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-traffic-status-upgrade-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    restoreLegacyTrafficRecordSchema(dbPath);

    const upgraded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    upgraded.close();

    const reader = new Database(dbPath, { readonly: true });
    const recordSql = reader.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record'",
    ).get().sql;
    const contract = captureCompetitionSchemaContract(reader);
    reader.close();

    assert.match(recordSql, /^CREATE TABLE "record"/);
    assert.equal(contract.length, COMPETITION_SCHEMA_CONTRACT.objectCount);
    assert.equal(competitionSchemaContractDigest(contract), COMPETITION_SCHEMA_CONTRACT.sha256);
    const result = validateDatabase(dbPath);
    assert.equal(result.status, 0, result.stderr);
  });

  it("accepts a full Competition database and rejects a schema-shaped subset", () => {
    const fullRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-full-db-validator-"));
    roots.push(fullRoot);
    const fullDb = path.join(fullRoot, "competition.db");
    createCompetitionUnit(fullDb, path.join(fullRoot, "uploads"));
    assert.equal(validateDatabase(fullDb).status, 0);
    const fullReader = new Database(fullDb, { readonly: true });
    const actualRuntimeSchema = captureCompetitionSchemaContract(fullReader);
    fullReader.close();
    assert.equal(actualRuntimeSchema.length, COMPETITION_SCHEMA_CONTRACT.objectCount);
    assert.equal(competitionSchemaContractDigest(actualRuntimeSchema), COMPETITION_SCHEMA_CONTRACT.sha256);
    const actualNames = new Set(actualRuntimeSchema.map(({ type, name }) => `${type}:${name}`));
    for (const { type, name } of COMPETITION_RUNTIME_SCHEMA) {
      assert.equal(actualNames.has(`${type}:${name}`), true, `${type}:${name} must exist`);
    }

    const minimalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-minimal-db-validator-"));
    roots.push(minimalRoot);
    const minimalDb = path.join(minimalRoot, "competition.db");
    createMinimalCompetitionUnit(minimalDb, path.join(minimalRoot, "uploads"));
    const result = validateDatabase(minimalDb);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime schema/);
  });

  it("accepts the exact pre-Registration schema and adds its tables at runtime without validator writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-registration-schema-upgrade-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    removeRegistrationSchema(dbPath);

    const predecessorResult = validateDatabase(dbPath);
    assert.equal(predecessorResult.status, 0, predecessorResult.stderr);
    const unchanged = new Database(dbPath, { readonly: true });
    assert.equal(
      unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_queue'").get(),
      undefined,
    );
    unchanged.close();

    const upgraded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    assert.ok(upgraded.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_queue'",
    ).get());
    assert.ok(upgraded.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_settings'",
    ).get());
    upgraded.close();
    const upgradedResult = validateDatabase(dbPath);
    assert.equal(upgradedResult.status, 0, upgradedResult.stderr);
  });

  it("accepts only the exact older predecessor schema and upgrades it at runtime without validator writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-schema-upgrade-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    removeRegistrationSchema(dbPath);

    const predecessor = new Database(dbPath);
    predecessor.exec("ALTER TABLE score_endurance DROP COLUMN qualified");
    predecessor.close();

    const predecessorResult = validateDatabase(dbPath);
    assert.equal(predecessorResult.status, 0, predecessorResult.stderr);
    const unchanged = new Database(dbPath, { readonly: true });
    assert.equal(
      unchanged.pragma("table_info('score_endurance')").some(({ name }) => name === "qualified"),
      false,
    );
    assert.equal(
      unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_queue'").get(),
      undefined,
    );
    unchanged.close();

    const upgraded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    assert.equal(
      upgraded.db.pragma("table_info('score_endurance')").some(({ name }) => name === "qualified"),
      true,
    );
    assert.ok(upgraded.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_queue'",
    ).get());
    upgraded.close();
    const upgradedResult = validateDatabase(dbPath);
    assert.equal(upgradedResult.status, 0, upgradedResult.stderr);
  });

  it("accepts the exact unconstrained qualification schema and adds the 0/1 check at runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-qualified-check-upgrade-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    const seeded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    seeded.teams.createTeam(CURRENT_YEAR, {
      number: 1,
      university: "Upgrade University",
      name: "Upgrade Team",
    });
    seeded.db.prepare("INSERT INTO score_endurance (year, team_num, qualified) VALUES (?, 1, 1)")
      .run(CURRENT_YEAR);
    seeded.close();
    removeRegistrationSchema(dbPath);
    removeQualifiedCheckConstraint(dbPath);

    const intermediate = new Database(dbPath, { readonly: true });
    assert.equal(
      competitionSchemaContractDigest(captureCompetitionSchemaContract(intermediate)),
      "bbfed20876a4642ecc6759441ac84d6c1c28e9b21689a8fafb2cfe4b44f400b4",
    );
    intermediate.close();
    const intermediateResult = validateDatabase(dbPath);
    assert.equal(intermediateResult.status, 0, intermediateResult.stderr);

    const upgraded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    const tableSql = upgraded.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'score_endurance'",
    ).get().sql;
    assert.match(tableSql, /qualified INTEGER NOT NULL DEFAULT 0 CHECK\(qualified IN \(0, 1\)\)/);
    assert.equal(
      upgraded.db.prepare("SELECT qualified FROM score_endurance WHERE year = ? AND team_num = 1")
        .get(CURRENT_YEAR).qualified,
      1,
    );
    assert.throws(
      () => upgraded.db.prepare("UPDATE score_endurance SET qualified = 2 WHERE year = ? AND team_num = 1")
        .run(CURRENT_YEAR),
      /CHECK constraint failed/,
    );
    upgraded.close();

    const upgradedResult = validateDatabase(dbPath);
    assert.equal(upgradedResult.status, 0, upgradedResult.stderr);
  });

  it("rejects an artifact with an out-of-domain endurance qualification value", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-qualified-domain-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);

    const seeded = createCompetitionApp({
      dbPath,
      uploadRoot: uploads,
      skipStaticValidation: true,
      validateUser: TRUST_JWT,
    });
    seeded.teams.createTeam(CURRENT_YEAR, {
      number: 1,
      university: "Qualification University",
      name: "Qualification Team",
    });
    seeded.close();

    removeQualifiedCheckConstraint(dbPath);
    const corrupt = new Database(dbPath);
    corrupt.prepare("INSERT INTO score_endurance (year, team_num, qualified) VALUES (?, 1, 2)")
      .run(CURRENT_YEAR);
    corrupt.close();

    const result = validateDatabase(dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /score_endurance<qualified-domain>/);
  });

  it("rejects a missing non-sentinel runtime column and removed roster-state schema", () => {
    const columnRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-column-db-validator-"));
    roots.push(columnRoot);
    const columnDb = path.join(columnRoot, "competition.db");
    createCompetitionUnit(columnDb, path.join(columnRoot, "uploads"));
    removeInspectionActiveColumn(columnDb);
    const columnResult = validateDatabase(columnDb);
    assert.notEqual(columnResult.status, 0);
    assert.match(columnResult.stderr, /inspection<table:definition>/);

    const typeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-type-db-validator-"));
    roots.push(typeRoot);
    const typeDb = path.join(typeRoot, "competition.db");
    createCompetitionUnit(typeDb, path.join(typeRoot, "uploads"));
    const typeWriter = new Database(typeDb);
    typeWriter.exec(`
      CREATE TABLE team_status (
        year INTEGER, team_num INTEGER, active INTEGER, revision INTEGER
      );
    `);
    typeWriter.close();
    const typeResult = validateDatabase(typeDb);
    assert.notEqual(typeResult.status, 0);
    assert.match(typeResult.stderr, /team_status<table:unexpected>/);
  });

  it("rejects a missing required foreign key without repairing the artifact", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-constraint-db-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    removeScheduledNotificationForeignKey(dbPath);

    const result = validateDatabase(dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scheduled_notification<table:definition>/);
    const reader = new Database(dbPath, { readonly: true });
    assert.deepEqual(reader.pragma("foreign_key_list('scheduled_notification')"), []);
    reader.close();
  });

  it("rejects unexpected executable schema objects without modifying them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-trigger-db-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    const uploads = path.join(root, "uploads");
    createCompetitionUnit(dbPath, uploads);
    addUnexpectedExecutableTrigger(dbPath);

    const result = validateDatabase(dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destructive_session_insert<trigger:unexpected>/);
    const reader = new Database(dbPath, { readonly: true });
    assert.equal(reader.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = 'destructive_session_insert'
    `).get().count, 1);
    reader.close();
  });

  it("rejects an altered executable object even when its allowed trigger name is unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-known-trigger-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    createCompetitionUnit(dbPath, path.join(root, "uploads"));
    const writer = new Database(dbPath);
    writer.exec(`
      DROP TRIGGER trg_logs_retention;
      CREATE TRIGGER trg_logs_retention AFTER INSERT ON logs
      BEGIN
        DELETE FROM scheduled_notification;
      END;
    `);
    writer.close();

    const result = validateDatabase(dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete-schema<contract:/);
  });

  it("accepts each complete support-service runtime schema", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-support-schema-validator-"));
    roots.push(root);
    const creators = {
      auth: (await import("../../auth/index.mjs")).createAuthApp,
      calendar: (await import("../../calendar/index.mjs")).createCalendarApp,
      course: (await import("../../course/index.mjs")).createCourseApp,
      email: (await import("../../email/index.mjs")).createEmailApp,
    };
    for (const [service, createApp] of Object.entries(creators)) {
      const dbPath = path.join(root, `${service}.db`);
      const created = createApp({ dbPath, skipStaticValidation: true });
      created.db.close();
      const result = validateSupportDatabase(service, dbPath);
      assert.equal(result.status, 0, `${service}: ${result.stdout}\n${result.stderr}`);
    }
  });

  it("rejects a Course backup missing durable mission protocol state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-mission-schema-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
    created.db.exec("DROP TABLE mission_command");
    created.db.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mission_command<table:missing>/);
  });

  it("rejects a Course backup with a weakened active-mission index predicate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-mission-index-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
    created.db.exec(`
      DROP INDEX idx_mission_one_active;
      CREATE UNIQUE INDEX idx_mission_one_active ON mission((1))
      WHERE lifecycle_state = 'running';
    `);
    created.db.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /idx_mission_one_active<index:definition>/);
  });

  it("rejects a Course backup with a dangling active mission command pointer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-mission-pointer-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
    created.db.prepare(`INSERT INTO mission
      (started_at,status,waypoints_json,current_waypoint_idx,spray_results_json,updated_at,
       created_at,lifecycle_state,finish_behavior,plan_hash,active_command_id,protocol_version)
      VALUES (1,'paused','[]',0,'{}',1,1,'ready','stop',?,'missing-command',2)`)
      .run("a".repeat(64));
    created.db.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid course mission state: .*active_command_id/);
  });

  it("rejects a Course backup with invalid v2 lifecycle and empty-plan semantics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-mission-semantic-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
    created.db.prepare(`INSERT INTO mission
      (started_at,status,waypoints_json,current_waypoint_idx,spray_results_json,updated_at,
       created_at,lifecycle_state,finish_behavior,plan_hash,empty_plan_mode,protocol_version)
      VALUES (1,'paused','[]',0,'{}',1,1,'teleporting','stop',?,'return_only',2)`)
      .run("b".repeat(64));
    created.db.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid course mission state: .*lifecycle_state/);
    assert.match(result.stderr, /return_only_finish_behavior/);
  });

  it("rejects unknown mission protocol versions and non-canonical plan hashes", () => {
    for (const mutation of ["protocol", "hash"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `fsk-course-${mutation}-validator-`));
      roots.push(root);
      const dbPath = path.join(root, "course.db");
      const { mission } = createPendingCourseMission(dbPath);
      const writer = new Database(dbPath);
      if (mutation === "protocol") {
        writer.prepare("UPDATE mission SET protocol_version=99 WHERE id=?").run(mission.id);
      } else {
        writer.prepare("UPDATE mission SET plan_hash=? WHERE id=?").run("f".repeat(64), mission.id);
      }
      writer.close();
      const result = validateSupportDatabase("course", dbPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, mutation === "protocol" ? /protocol_version/ : /plan_hash_content/);
    }
  });

  it("rejects an orphan pending command even without a forward mission pointer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-orphan-command-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const { mission, commandId } = createPendingCourseMission(dbPath);
    const writer = new Database(dbPath);
    writer.prepare(`UPDATE mission SET lifecycle_state='ready',status='paused',active_command_id=NULL
      WHERE id=?`).run(mission.id);
    writer.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`command#${commandId}:orphan_pending`));
  });

  it("rejects pending commands whose executable payload no longer matches durable mission state", () => {
    const mutations = [
      ["finish", (payload) => { payload.finish_behavior = "return_to_start"; }, /executable_context/],
      ["waypoint", (payload) => { payload.waypoints[0].lat += 1; }, /:waypoints/],
      ["shape", (payload) => { payload.unreviewed_field = true; }, /payload_shape/],
      ["occurrence", (payload) => { payload.expected_occurrence_revision = null; }, /occurrence_revision/],
    ];
    for (const [name, mutate, expected] of mutations) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `fsk-course-payload-${name}-validator-`));
      roots.push(root);
      const dbPath = path.join(root, "course.db");
      const { commandId } = createPendingCourseMission(dbPath);
      const writer = new Database(dbPath);
      const row = writer.prepare("SELECT payload_json FROM mission_command WHERE id=?").get(commandId);
      const payload = JSON.parse(row.payload_json);
      mutate(payload);
      writer.prepare("UPDATE mission_command SET payload_json=? WHERE id=?")
        .run(JSON.stringify(payload), commandId);
      writer.close();
      const result = validateSupportDatabase("course", dbPath);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
    }
  });

  it("rejects a return-only ready mission without a durable start position", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-return-only-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const { mission } = createPendingCourseMission(dbPath);
    const writer = new Database(dbPath);
    writer.prepare("UPDATE mission_command SET state='superseded' WHERE mission_id=?").run(mission.id);
    writer.prepare(`UPDATE mission SET lifecycle_state='ready',status='paused',active_command_id=NULL,
      empty_plan_mode='return_only',finish_behavior='return_to_start',start_lat=NULL,start_lng=NULL
      WHERE id=?`).run(mission.id);
    writer.prepare("UPDATE mission_waypoint SET state='skipped' WHERE mission_id=?").run(mission.id);
    writer.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /return_only_start_position/);
  });

  it("rejects terminal and reboot-hold fence combinations that runtime cannot publish", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-course-mission-fence-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "course.db");
    const created = supportAppCreators.course({ dbPath, skipStaticValidation: true });
    const planHash = "c".repeat(64);
    const missionId = Number(created.db.prepare(`INSERT INTO mission
      (started_at,ended_at,status,waypoints_json,current_waypoint_idx,spray_results_json,updated_at,
       created_at,lifecycle_state,finish_behavior,plan_hash,active_command_id,active_hold_id,hold_reason,protocol_version)
      VALUES (1,2,'completed','[]',0,'{}',2,1,'completed','stop',?,'end-command','hold-after-end','rover_rebooted',2)`)
      .run(planHash).lastInsertRowid);
    created.db.prepare(`INSERT INTO mission_command
      (id,mission_id,command_seq,action,plan_hash,state,requested_at,payload_json)
      VALUES ('end-command',?,1,'end',?,'pending',1,?)`).run(
      missionId,
      planHash,
      JSON.stringify({
        protocol_version: 2,
        command_id: "end-command",
        command_seq: 1,
        mission_id: missionId,
        action: "end",
        plan_hash: planHash,
      }),
    );
    created.db.close();

    const result = validateSupportDatabase("course", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /terminal_fence/);
    assert.match(result.stderr, /reboot_hold/);
  });

  it("rejects support tables that have every required name but unusable columns", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-support-column-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "auth.db");
    createNamedButMalformedAuthDatabase(dbPath);

    const result = validateSupportDatabase("auth", dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /users<table:columns>/);
  });

  it("rejects foreign-key and canonical team-reference violations", () => {
    const foreignKeyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-fk-db-validator-"));
    roots.push(foreignKeyRoot);
    const foreignKeyDb = path.join(foreignKeyRoot, "competition.db");
    createCompetitionUnit(foreignKeyDb, path.join(foreignKeyRoot, "uploads"));
    const foreignKeyWriter = new Database(foreignKeyDb);
    foreignKeyWriter.pragma("foreign_keys = OFF");
    foreignKeyWriter.prepare(`
      INSERT INTO submission_file
        (submission_id, original_name, stored_name, size, mime_type, text_charset)
      VALUES (999, 'missing.pdf', 'missing.pdf', 1, 'application/pdf', '')
    `).run();
    foreignKeyWriter.close();
    const foreignKeyResult = validateDatabase(foreignKeyDb);
    assert.notEqual(foreignKeyResult.status, 0);
    assert.match(foreignKeyResult.stderr, /foreign_key_check/);

    const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-canonical-db-validator-"));
    roots.push(canonicalRoot);
    const canonicalDb = path.join(canonicalRoot, "competition.db");
    createCompetitionUnit(canonicalDb, path.join(canonicalRoot, "uploads"));
    const canonicalWriter = new Database(canonicalDb);
    const typeId = Number(canonicalWriter.prepare(`
      INSERT INTO competition_vehicle_type (year, display_name, color, sort_order)
      VALUES (2026, 'Test', 'blue', 0)
    `).run().lastInsertRowid);
    canonicalWriter.prepare(`
      INSERT INTO competition_team (year, num, univ, name, vehicle_type_id)
      VALUES (2026, 7, 'Test University', 'Test', ?)
    `).run(typeId);
    canonicalWriter.prepare(
      "INSERT INTO student_team (email, team_num, year) VALUES ('student@test.invalid', 7, 2026)",
    ).run();
    canonicalWriter.prepare(
      "UPDATE student_team SET team_id = NULL WHERE email = 'student@test.invalid' AND year = 2026",
    ).run();
    canonicalWriter.close();
    const canonicalResult = validateDatabase(canonicalDb);
    assert.notEqual(canonicalResult.status, 0);
    assert.match(canonicalResult.stderr, /canonical team references/);
  });

  it("validates persisted live bindings independently of the wall-clock year", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-live-team-binding-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    createCompetitionUnit(dbPath, path.join(root, "uploads"));
    const writer = new Database(dbPath);
    const previousYear = CURRENT_YEAR - 1;
    const currentTeamId = Number(writer.prepare(`
      INSERT INTO competition_team (year, num, univ, name)
      VALUES (?, 7, 'Current University', 'Current Team')
    `).run(CURRENT_YEAR).lastInsertRowid);
    const historicalTeamId = Number(writer.prepare(`
      INSERT INTO competition_team (year, num, univ, name)
      VALUES (?, 7, 'Historical University', 'Historical Team')
    `).run(previousYear).lastInsertRowid);
    const eventType = writer.prepare("SELECT event_type FROM wireless_session ORDER BY event_type LIMIT 1").get().event_type;
    writer.prepare("UPDATE wireless_session SET team_json = ? WHERE event_type = ?")
      .run(JSON.stringify({ id: historicalTeamId, teamId: historicalTeamId, num: 7 }), eventType);
    assert.equal(
      writer.prepare("SELECT team_id FROM wireless_session WHERE event_type = ?").get(eventType).team_id,
      historicalTeamId,
    );
    const booth = writer.prepare("SELECT inspection, booth_num FROM booth ORDER BY inspection, booth_num LIMIT 1").get();
    writer.prepare(`
      INSERT INTO booth_log
        (num, inspection, booth_num, entered_at, exited_at, created_at, year, team_id)
      VALUES (7, ?, ?, 1, NULL, 1, ?, ?)
    `).run(booth.inspection, booth.booth_num, previousYear, historicalTeamId);
    writer.prepare(`
      UPDATE booth SET occupied_by = 7, occupied_team_id = ?, entered_at = 1
      WHERE inspection = ? AND booth_num = ?
    `).run(historicalTeamId, booth.inspection, booth.booth_num);
    writer.close();

    const historicalResult = validateDatabase(dbPath);
    assert.equal(historicalResult.status, 0, historicalResult.stderr);

    const mismatchedWriter = new Database(dbPath);
    mismatchedWriter.prepare("UPDATE wireless_session SET team_id = ? WHERE event_type = ?")
      .run(currentTeamId, eventType);
    mismatchedWriter.prepare("UPDATE booth SET occupied_team_id = ? WHERE inspection = ? AND booth_num = ?")
      .run(currentTeamId, booth.inspection, booth.booth_num);
    mismatchedWriter.close();

    const mismatchedResult = validateDatabase(dbPath);
    assert.notEqual(mismatchedResult.status, 0);
    assert.match(mismatchedResult.stderr, /wireless_session=1/);
    assert.match(mismatchedResult.stderr, /booth=1/);

    const inactiveWriter = new Database(dbPath);
    inactiveWriter.prepare("UPDATE wireless_session SET team_id = ? WHERE event_type = ?")
      .run(historicalTeamId, eventType);
    inactiveWriter.prepare("UPDATE booth SET occupied_team_id = ? WHERE inspection = ? AND booth_num = ?")
      .run(historicalTeamId, booth.inspection, booth.booth_num);
    inactiveWriter.prepare("UPDATE competition_team SET active = 0 WHERE id = ?").run(historicalTeamId);
    inactiveWriter.close();

    const inactiveResult = validateDatabase(dbPath);
    assert.notEqual(inactiveResult.status, 0);
    assert.match(inactiveResult.stderr, /wireless_session=1/);
    assert.match(inactiveResult.stderr, /booth=1/);
  });

  it("rejects a team whose vehicle type belongs to another year", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-team-type-year-validator-"));
    roots.push(root);
    const dbPath = path.join(root, "competition.db");
    createCompetitionUnit(dbPath, path.join(root, "uploads"));
    const writer = new Database(dbPath);
    const historicalTypeId = Number(writer.prepare(`
      INSERT INTO competition_vehicle_type (year, display_name, color, sort_order)
      VALUES (?, 'Historical Type', 'blue', 0)
    `).run(CURRENT_YEAR - 1).lastInsertRowid);
    writer.prepare(`
      INSERT INTO competition_team (year, num, univ, name, vehicle_type_id)
      VALUES (?, 8, 'Current University', 'Cross-year Type', ?)
    `).run(CURRENT_YEAR, historicalTypeId);
    writer.close();

    const result = validateDatabase(dbPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /competition_team\.vehicle_type_id=1/);
  });

  it("rejects an incomplete restore before stopping services or touching live data", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture({ minimalDatabase: true });
    const before = treeHash(liveData);
    const podmanLog = path.join(root, "podman.log");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_LOG: podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime schema/);
    assert.equal(fs.existsSync(podmanLog), false);
    assert.equal(treeHash(liveData), before);
  });

  it("rejects a restore missing a runtime column before stopping services or touching live data", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture({ missingRuntimeColumn: true });
    const before = treeHash(liveData);
    const podmanLog = path.join(root, "podman.log");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_LOG: podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inspection<table:definition>/);
    assert.equal(fs.existsSync(podmanLog), false);
    assert.equal(treeHash(liveData), before);
  });

  it("rejects a restore missing a required constraint before stopping services or touching live data", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture({ missingRequiredConstraint: true });
    const before = treeHash(liveData);
    const podmanLog = path.join(root, "podman.log");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_LOG: podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scheduled_notification<table:definition>/);
    assert.equal(fs.existsSync(podmanLog), false);
    assert.equal(treeHash(liveData), before);
  });

  it("rejects a restore with an unexpected trigger before stopping services or touching live data", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture({ unexpectedExecutableTrigger: true });
    const before = treeHash(liveData);
    const podmanLog = path.join(root, "podman.log");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_LOG: podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destructive_session_insert<trigger:unexpected>/);
    assert.equal(fs.existsSync(podmanLog), false);
    assert.equal(treeHash(liveData), before);
  });

  it("rejects a corrupt support-service database before stopping services or touching live data", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, liveAuth, fakeBin } = createRestoreFixture({ corruptSupportDatabase: true });
    const beforeCompetition = treeHash(liveData);
    const beforeAuth = fs.readFileSync(liveAuth, "utf8");
    const podmanLog = path.join(root, "podman.log");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_LOG: podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /auth DB/);
    assert.equal(fs.existsSync(podmanLog), false);
    assert.equal(treeHash(liveData), beforeCompetition);
    assert.equal(fs.readFileSync(liveAuth, "utf8"), beforeAuth);
  });

  it("rejects named but structurally unusable support data before stopping services", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createRestoreFixture({ malformedNamedSupportSchema: true });
    const beforeCompetition = treeHash(fixture.liveData);
    const beforeAuth = fs.readFileSync(fixture.liveAuth, "utf8");
    const result = spawnSync("bash", [path.join(fixture.root, "scripts", "restore.sh"), fixture.zipPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, PODMAN_LOG: fixture.podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /users<table:columns>/);
    assert.equal(fs.existsSync(fixture.podmanLog), false);
    assert.equal(treeHash(fixture.liveData), beforeCompetition);
    assert.equal(fs.readFileSync(fixture.liveAuth, "utf8"), beforeAuth);
  });

  it("rejects semantically invalid Course mission state before stopping services", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createRestoreFixture({ invalidCourseMissionState: true });
    const beforeCompetition = treeHash(fixture.liveData);
    const beforeAuth = fs.readFileSync(fixture.liveAuth, "utf8");
    const result = spawnSync("bash", [path.join(fixture.root, "scripts", "restore.sh"), fixture.zipPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, PODMAN_LOG: fixture.podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid course mission state/);
    assert.equal(fs.existsSync(fixture.podmanLog), false);
    assert.equal(treeHash(fixture.liveData), beforeCompetition);
    assert.equal(fs.readFileSync(fixture.liveAuth, "utf8"), beforeAuth);
  });

  it("rejects a restore missing a required support database before stopping services", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createRestoreFixture({ missingSupportDatabase: "auth" });
    const before = treeHash(fixture.liveData);
    const result = spawnSync("bash", [path.join(fixture.root, "scripts", "restore.sh"), fixture.zipPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, PODMAN_LOG: fixture.podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /필수 DB가 없거나 일반 파일이 아닙니다/);
    assert.equal(fs.existsSync(fixture.podmanLog), false);
    assert.equal(treeHash(fixture.liveData), before);
  });

  it("rejects a symlinked staged Competition database before stopping services", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createRestoreFixture({ symlinkCompetitionDatabase: true });
    const before = treeHash(fixture.liveData);
    const result = spawnSync("bash", [path.join(fixture.root, "scripts", "restore.sh"), fixture.zipPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, PODMAN_LOG: fixture.podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Competition DB가 일반 파일이 아닙니다|필수 DB가 없거나 일반 파일이 아닙니다/);
    assert.equal(fs.existsSync(fixture.podmanLog), false);
    assert.equal(treeHash(fixture.liveData), before);
  });

  it("rejects an intermediate upload symlink before stopping services", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createRestoreFixture({ intermediateUploadSymlink: true });
    const before = treeHash(fixture.liveData);
    const result = spawnSync("bash", [path.join(fixture.root, "scripts", "restore.sh"), fixture.zipPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, PODMAN_LOG: fixture.podmanLog },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
    assert.equal(fs.existsSync(fixture.podmanLog), false);
    assert.equal(treeHash(fixture.liveData), before);
  });

  it("does not touch live destinations when compose fails to stop writers", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture();
    const before = treeHash(liveData);
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_MODE: "fail" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /서비스 중지에 실패했습니다/);
    assert.equal(treeHash(liveData), before);
  });

  it("does not touch live destinations when a writer remains after compose down", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture();
    const before = treeHash(liveData);
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PODMAN_MODE: "partial" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /중지되지 않은 서비스/);
    assert.equal(treeHash(liveData), before);
  });

  it("rolls back a live database moved aside before the staged rename fails", { skip: !operationalScriptsAvailable }, () => {
    const { root, zipPath, liveData, fakeBin } = createRestoreFixture();
    const before = treeHash(liveData);
    const realMv = spawnSync("which", ["mv"], { encoding: "utf8" }).stdout.trim();
    writeExecutable(path.join(fakeBin, "mv"), `#!/bin/sh
if [ "$1" = "$FAIL_MV_SOURCE" ] && [ "$2" = "$FAIL_MV_DEST" ]; then
  printf 'injected staged rename failure\\n' >&2
  exit 42
fi
exec "${realMv}" "$@"
`);
    const dbPath = path.join(liveData, "competition.db");
    const result = spawnSync("bash", [path.join(root, "scripts", "restore.sh"), zipPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PODMAN_MODE: "success",
        FAIL_MV_SOURCE: `${dbPath}.new`,
        FAIL_MV_DEST: dbPath,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected staged rename failure/);
    assert.equal(treeHash(liveData), before);
    assert.equal(fs.existsSync(`${dbPath}.bak`), false);
    assert.equal(fs.existsSync(`${dbPath}.new`), false);
  });

  it("publishes a complete validated backup without a partial archive", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture();
    const result = runBackup(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const archive = path.join(fixture.destination, "fsk-backup-20260811-123456.zip");
    assert.equal(fs.existsSync(archive), true);
    assert.equal(spawnSync("unzip", ["-tq", archive]).status, 0);
    assert.deepEqual(fs.readdirSync(fixture.destination), [path.basename(archive)]);
  });

  it("does not publish a backup with an incomplete Competition database", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ minimalDatabase: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime schema/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup with an intermediate upload symlink", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ intermediateUploadSymlink: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /심볼릭 링크/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not hide a symlinked live upload root or ancestor while copying", { skip: !operationalScriptsAvailable }, () => {
    for (const kind of ["root", "ancestor"]) {
      const fixture = createBackupFixture();
      const competition = path.join(fixture.root, "competition");
      if (kind === "root") {
        const uploads = path.join(competition, "data", "uploads");
        const realUploads = path.join(competition, "data", "real-uploads");
        fs.renameSync(uploads, realUploads);
        fs.symlinkSync("real-uploads", uploads, "dir");
      } else {
        const data = path.join(competition, "data");
        const realData = path.join(competition, "real-data");
        fs.renameSync(data, realData);
        fs.symlinkSync("real-data", data, "dir");
      }

      const result = runBackup(fixture);
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /심볼릭 링크/, kind);
      assert.deepEqual(fs.readdirSync(fixture.destination), [], kind);
    }
  });

  it("does not publish any backup when the Competition database is missing", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture();
    fs.unlinkSync(path.join(fixture.root, "competition", "data", "competition.db"));
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Competition DB가 없거나 일반 파일이 아닙니다/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup when a required support database is missing", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ missingSupportDatabase: "auth" });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /필수 지원 서비스 DB가 없거나 일반 파일이 아닙니다: auth/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup missing a runtime column", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ missingRuntimeColumn: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inspection<table:definition>/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup missing a required constraint", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ missingRequiredConstraint: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scheduled_notification<table:definition>/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup containing an unexpected trigger", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ unexpectedExecutableTrigger: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destructive_session_insert<trigger:unexpected>/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup with an invalid support-service schema", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ invalidSupportSchema: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /users<table:missing>/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish named but structurally unusable support-service data", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ malformedNamedSupportSchema: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /users<table:columns>/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish a backup with semantically invalid Course mission state", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ invalidCourseMissionState: true });
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid course mission state/);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("backs up only the FileBrowser file tree without coupling to its private database or lifecycle", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture({ fileBrowserFiles: true });
    const result = runBackup(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const archive = path.join(fixture.destination, "fsk-backup-20260811-123456.zip");
    const extracted = path.join(fixture.root, "extracted");
    fs.mkdirSync(extracted);
    const unzip = spawnSync("unzip", ["-qo", archive, "-d", extracted], { encoding: "utf8" });
    assert.equal(unzip.status, 0, unzip.stderr);
    assert.equal(fs.existsSync(path.join(extracted, "db", "filebrowser.db")), false);
    assert.equal(
      fs.readFileSync(path.join(extracted, "filebrowser", "files", "generation.txt"), "utf8"),
      "generation-one",
    );
    assert.doesNotMatch(fs.readFileSync(fixture.podmanLog, "utf8"), /fsk-filebrowser/);
  });

  it("removes a partial archive when compression fails", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture();
    writeExecutable(path.join(fixture.fakeBin, "zip"), `#!/bin/sh
printf "partial" > "$2"
exit 42
`);
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("does not publish an archive that fails ZIP validation", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture();
    writeExecutable(path.join(fixture.fakeBin, "unzip"), "#!/bin/sh\nexit 42\n");
    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(fixture.destination), []);
  });

  it("refuses to update an existing final backup path", { skip: !operationalScriptsAvailable }, () => {
    const fixture = createBackupFixture();
    fs.mkdirSync(fixture.destination, { recursive: true });
    const staleRoot = path.join(fixture.root, "stale");
    fs.mkdirSync(staleRoot);
    fs.writeFileSync(path.join(staleRoot, "stale.txt"), "must remain");
    const archive = path.join(fixture.destination, "fsk-backup-20260811-123456.zip");
    assert.equal(spawnSync("zip", ["-qr", archive, "."], { cwd: staleRoot }).status, 0);
    const before = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");

    const result = runBackup(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /이미 존재합니다/);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), before);
    assert.deepEqual(fs.readdirSync(fixture.destination), [path.basename(archive)]);
  });

  it("keeps both operational scripts syntactically valid", () => {
    for (const script of ["scripts/backup.sh", "scripts/restore.sh"]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
  });
});
