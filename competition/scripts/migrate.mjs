import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createCompetitionApp } from "../index.mjs";
import { assertCanonicalTeamReferences, installCanonicalTeamReferences } from "../lib/team-references.mjs";
import { validateCompetitionDatabase } from "../lib/database-validation.mjs";
import { clearInactiveTeamLiveState } from "./migration-normalization.mjs";
import { VEHICLE_COLORS } from "../../shared/constants.js";

const SERVICES = Object.freeze(["entry", "queue", "inspection", "traffic", "score", "documents"]);
const SKIP_TABLES = new Set([
  "logs", "schema_migrations", "team_status", "lifecycle_outbox", "entry_active_revision",
  "team_renumber_file_work",
]);
const SOURCE_SCHEMA_SENTINELS = Object.freeze({
  queue: Object.freeze([
    Object.freeze({ table: "inspection", columns: Object.freeze(["type", "name"]) }),
    Object.freeze({
      table: "booth_log",
      columns: Object.freeze(["num", "inspection", "booth_num", "entered_at", "exited_at"]),
    }),
  ]),
  inspection: Object.freeze([
    Object.freeze({ table: "sheet_template", columns: Object.freeze(["year", "level", "name"]) }),
    Object.freeze({ table: "sheet_answer", columns: Object.freeze(["year", "team_num", "item_id"]) }),
  ]),
  traffic: Object.freeze([
    Object.freeze({ table: "event_mode", columns: Object.freeze(["event_type", "enabled"]) }),
    Object.freeze({ table: "record_visibility", columns: Object.freeze(["name", "visible"]) }),
  ]),
  score: Object.freeze([
    Object.freeze({ table: "score_manual", columns: Object.freeze(["year", "team_num", "score_type"]) }),
    Object.freeze({ table: "score_penalty", columns: Object.freeze(["year", "event_type", "cone_penalty", "oc_penalty"]) }),
  ]),
  documents: Object.freeze([
    Object.freeze({ table: "session", columns: Object.freeze(["id", "name", "year"]) }),
    Object.freeze({ table: "submission_file", columns: Object.freeze(["submission_id", "stored_name"]) }),
  ]),
});

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableColumns(db, schema, table) {
  return db.prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`).all();
}

function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function openSourceGuards(sources) {
  const guards = {};
  try {
    for (const service of SERVICES) {
      const db = new Database(sources[service], { readonly: true, fileMustExist: true });
      guards[service] = { db, dataVersion: db.pragma("data_version", { simple: true }) };
    }
    return guards;
  } catch (error) {
    for (const guard of Object.values(guards)) guard.db.close();
    throw error;
  }
}

function assertSourceGuardsUnchanged(guards) {
  for (const [service, guard] of Object.entries(guards)) {
    const actual = guard.db.pragma("data_version", { simple: true });
    if (actual !== guard.dataVersion) throw new Error(`legacy source changed during migration: ${service}`);
  }
}

function legacyDocumentFileCount(source) {
  const exists = source.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submission_file'",
  ).get();
  if (!exists) return 0;
  return source.prepare("SELECT COUNT(*) AS count FROM submission_file").get().count;
}

function attach(db, alias, sourcePath) {
  db.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(alias)}`).run(sourcePath);
}

function detach(db, alias) {
  db.exec(`DETACH DATABASE ${quoteIdentifier(alias)}`);
}

function importLogs(db, schema, module, report) {
  const exists = db.prepare(
    `SELECT 1 FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'table' AND name = 'logs'`,
  ).get();
  if (!exists) return;
  const sourceColumns = new Set(tableColumns(db, schema, "logs").map((column) => column.name));
  const targetColumns = [
    "timestamp", "level", "action", "actor_email", "actor_name", "actor_role", "target", "detail", "ip",
  ].filter((column) => sourceColumns.has(column));
  const selectColumns = targetColumns.map(quoteIdentifier).join(", ");
  const insertColumns = ["module", ...targetColumns].map(quoteIdentifier).join(", ");
  const placeholders = ["?", ...targetColumns.map(() => "?")].join(", ");
  const insert = db.prepare(`INSERT INTO logs (${insertColumns}) VALUES (${placeholders})`);
  let count = 0;
  for (const row of db.prepare(
    `SELECT ${selectColumns} FROM ${quoteIdentifier(schema)}.${quoteIdentifier("logs")} ORDER BY id`,
  ).all()) {
    insert.run(module, ...targetColumns.map((column) => row[column]));
    count += 1;
  }
  report.tables[`${module}.logs`] = count;
}

function importCanonicalTeams(db, schema, report) {
  const tables = db.prepare(`
    SELECT name FROM ${quoteIdentifier(schema)}.sqlite_master
    WHERE type = 'table' AND name GLOB 'entry_[0-9][0-9][0-9][0-9]'
    ORDER BY name
  `).all();
  const insertType = db.prepare(`
    INSERT INTO competition_vehicle_type (year, display_name, color, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  const insertTeam = db.prepare(`
    INSERT INTO competition_team (year, num, univ, name, vehicle_type_id, active)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const { name: entryTable } of tables) {
    const year = Number(entryTable.slice("entry_".length));
    const typeTable = `vehicle_types_${year}`;
    const hasTypes = db.prepare(`
      SELECT 1 FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'table' AND name = ?
    `).get(typeTable);
    const typeIds = new Map();
    if (hasTypes) {
      const typeColumns = new Set(tableColumns(db, schema, typeTable).map((column) => column.name));
      const colorSql = typeColumns.has("color") ? "color" : "'blue' AS color";
      const orderSql = typeColumns.has("sort_order") ? "sort_order" : "id AS sort_order";
      for (const row of db.prepare(`
        SELECT name, ${colorSql}, ${orderSql}
        FROM ${quoteIdentifier(schema)}.${quoteIdentifier(typeTable)} ORDER BY sort_order, id
      `).all()) {
        const color = VEHICLE_COLORS.includes(row.color) ? row.color : "blue";
        const result = insertType.run(year, row.name, color, Number(row.sort_order) || 0);
        typeIds.set(row.name, Number(result.lastInsertRowid));
      }
    }

    const columns = new Set(tableColumns(db, schema, entryTable).map((column) => column.name));
    const typeSql = columns.has("type") ? "type" : "NULL AS type";
    const activeSql = columns.has("active") ? "active" : "1 AS active";
    let teamCount = 0;
    for (const row of db.prepare(`
      SELECT num, univ, team, ${typeSql}, ${activeSql}
      FROM ${quoteIdentifier(schema)}.${quoteIdentifier(entryTable)} ORDER BY num
    `).all()) {
      const vehicleTypeId = row.type == null ? null : typeIds.get(row.type);
      if (row.type != null && !vehicleTypeId) {
        throw new Error(`${entryTable} team #${row.num} references unknown vehicle type '${row.type}'`);
      }
      insertTeam.run(
        year,
        row.num,
        row.univ,
        row.team,
        vehicleTypeId,
        row.active === 0 ? 0 : 1,
      );
      teamCount += 1;
    }
    report.tables[`entry.${entryTable}`] = teamCount;
    report.tables[`entry.${typeTable}`] = typeIds.size;
  }
}

function copyServiceTables(db, schema, service, report) {
  const tables = db.prepare(`
    SELECT name, sql FROM ${quoteIdentifier(schema)}.sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  for (const { name, sql } of tables) {
    if (SKIP_TABLES.has(name) || /^entry_\d{4}$/.test(name) || /^vehicle_types_\d{4}$/.test(name)) continue;
    let targetExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
    if (!targetExists) {
      if (!sql) throw new Error(`cannot recreate ${service}.${name}: missing schema SQL`);
      db.exec(sql);
      targetExists = true;
    }
    const sourceTableColumns = tableColumns(db, schema, name);
    const sourceColumns = new Set(sourceTableColumns.map((column) => column.name));
    const common = tableColumns(db, "main", name)
      .map((column) => column.name)
      .filter((column) => sourceColumns.has(column));
    if (!common.length) throw new Error(`no compatible columns for ${service}.${name}`);
    const columnSql = common.map(quoteIdentifier).join(", ");
    // Traffic's former per-event record tables used SQLite's implicit rowid as
    // the externally stored record identity. Preserve it through the staging
    // copy so gaps do not compact and wireless_session.saved_record_rowid keeps
    // pointing at the same record during the factory normalization pass.
    const preserveImplicitRowid = service === "traffic"
      && name !== "record"
      && ["time", "num", "univ", "team", "type", "result"].every((column) => sourceColumns.has(column))
      && sourceTableColumns.every((column) => column.pk === 0);
    const sourceCount = db.prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`,
    ).get().count;
    const insertColumns = preserveImplicitRowid ? `rowid, ${columnSql}` : columnSql;
    const selectColumns = preserveImplicitRowid ? `rowid, ${columnSql}` : columnSql;
    db.exec(`
      INSERT OR REPLACE INTO ${quoteIdentifier(name)} (${insertColumns})
      SELECT ${selectColumns} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}
    `);
    report.tables[`${service}.${name}`] = sourceCount;
  }
}

function assertExpectedSourceSchema(service, sourcePath) {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (service === "entry") {
      const entryTables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name GLOB 'entry_[0-9][0-9][0-9][0-9]'
        ORDER BY name
      `).all().map((row) => row.name);
      const matchingYear = entryTables.find((entryTable) => {
        const entryColumns = new Set(tableColumns(db, "main", entryTable).map((column) => column.name));
        if (!["num", "univ", "team"].every((column) => entryColumns.has(column))) return false;
        const typeTable = `vehicle_types_${entryTable.slice("entry_".length)}`;
        const typeExists = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(typeTable);
        if (!typeExists) return false;
        const typeColumns = new Set(tableColumns(db, "main", typeTable).map((column) => column.name));
        return typeColumns.has("name");
      });
      if (!matchingYear) {
        throw new Error("missing a compatible entry_YYYY and vehicle_types_YYYY table pair");
      }
      return;
    }

    const missing = [];
    for (const sentinel of SOURCE_SCHEMA_SENTINELS[service]) {
      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(sentinel.table);
      if (!exists) {
        missing.push(sentinel.table);
        continue;
      }
      const actual = new Set(tableColumns(db, "main", sentinel.table).map((column) => column.name));
      const missingColumns = sentinel.columns.filter((column) => !actual.has(column));
      if (missingColumns.length) missing.push(`${sentinel.table}[${missingColumns.join(",")}]`);
    }
    if (missing.length) throw new Error(`missing or incompatible sentinels: ${missing.join(", ")}`);
  } catch (error) {
    throw new Error(`source database for ${service} does not match the expected schema: ${error.message}`);
  } finally {
    db.close();
  }
}

function validateSources(sources) {
  const seenPaths = new Map();
  const seenFiles = new Map();
  for (const service of SERVICES) {
    const sourcePath = sources?.[service];
    if (!sourcePath) throw new Error(`missing source database for ${service}`);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error(`source database is not a file: ${sourcePath}`);
    const resolved = fs.realpathSync.native(sourcePath);
    const duplicatePath = seenPaths.get(resolved);
    const fileIdentity = `${stat.dev}:${stat.ino}`;
    const duplicateFile = seenFiles.get(fileIdentity);
    const duplicate = duplicatePath || duplicateFile;
    if (duplicate) {
      throw new Error(
        `source databases must be distinct: ${service} and ${duplicate} resolve to the same file (${resolved})`,
      );
    }
    seenPaths.set(resolved, service);
    seenFiles.set(fileIdentity, service);
    assertExpectedSourceSchema(service, resolved);
  }
}

function assignStableSubmissionStorage(db, report) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submission'",
  ).get();
  if (!exists) return;
  const columns = new Set(tableColumns(db, "main", "submission").map((column) => column.name));
  if (!columns.has("team_id") || !columns.has("storage_dir")) return;
  const result = db.prepare(`
    UPDATE submission
    SET storage_dir = CAST(session_id AS TEXT) || '/team-' || CAST(team_id AS TEXT) || '/' || CAST(id AS TEXT)
    WHERE team_id IS NOT NULL AND storage_dir IS NULL
  `).run();
  report.tables["documents.submission_storage"] = result.changes;
}

function assertExistingPathComponentsAreNotSymlinks(targetPath, description) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === "ENOENT") return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${description} path contains a symbolic link: ${cursor}`);
    }
  }
  return absolute;
}

async function copyAndRelocateUploads({ sourceUploads, stagedUploads, dbPath, report }) {
  const sourceRoot = assertExistingPathComponentsAreNotSymlinks(sourceUploads, "source uploads");
  const stat = await fsp.stat(sourceRoot);
  if (!stat.isDirectory()) throw new Error(`source uploads is not a directory: ${sourceUploads}`);
  await fsp.mkdir(stagedUploads, { recursive: false });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let submissions;
  let files;
  try {
    submissions = db.prepare(`
      SELECT id, session_id, team_num, storage_dir
      FROM submission
      WHERE storage_dir IS NOT NULL
      ORDER BY session_id, team_num, id
    `).all();
    files = db.prepare(`
      SELECT f.id, f.stored_name, s.id AS submission_id, s.session_id, s.team_num, s.storage_dir
      FROM submission_file f
      LEFT JOIN submission s ON s.id = f.submission_id
      ORDER BY f.id
    `).all();
  } finally {
    db.close();
  }

  const stagedRoot = path.resolve(stagedUploads);
  for (const file of files) {
    if (!file.storage_dir || !file.stored_name) {
      throw new Error(`referenced upload has incomplete metadata: submission_file ${file.id}`);
    }
    const source = path.resolve(
      sourceRoot, String(file.session_id), String(file.team_num), String(file.submission_id), file.stored_name,
    );
    const sourceRelative = path.relative(sourceRoot, source);
    if (!sourceRelative || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) {
      throw new Error(`referenced legacy upload escapes the source directory: submission_file ${file.id}`);
    }
    const target = path.resolve(stagedRoot, file.storage_dir, file.stored_name);
    const relative = path.relative(stagedRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`referenced upload escapes the target directory: submission_file ${file.id}`);
    }
    let sourceStat;
    try {
      sourceStat = await fsp.lstat(source);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`referenced upload is missing: submission_file ${file.id} (${sourceRelative})`);
      }
      throw error;
    }
    if (!sourceStat.isFile()) {
      throw new Error(`referenced upload is not a regular file: submission_file ${file.id} (${sourceRelative})`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }

  report.uploads = {
    source: path.resolve(sourceUploads),
    submissions: submissions.length,
    copiedReferencedFiles: files.length,
    referencedFiles: files.length,
    unreferencedFilesCopied: 0,
  };
}

function referencedUploadsSha256(sourceUploads, dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let files;
  try {
    files = db.prepare(`
      SELECT f.id, f.stored_name, s.id AS submission_id, s.session_id, s.team_num
      FROM submission_file f JOIN submission s ON s.id = f.submission_id ORDER BY f.id
    `).all();
  } finally {
    db.close();
  }
  const sourceRoot = assertExistingPathComponentsAreNotSymlinks(sourceUploads, "source uploads");
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const lexical = path.resolve(
      sourceRoot, String(file.session_id), String(file.team_num), String(file.submission_id), file.stored_name,
    );
    const relative = path.relative(sourceRoot, lexical);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`referenced legacy upload escapes the source directory: submission_file ${file.id}`);
    }
    let cursor = sourceRoot;
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component);
      let stat;
      try { stat = fs.lstatSync(cursor); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error(`referenced upload is missing: submission_file ${file.id} (${relative})`);
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`referenced upload contains a symbolic link: submission_file ${file.id} (${relative})`);
      }
    }
    if (!fs.statSync(lexical).isFile()) {
      throw new Error(`referenced upload is not a regular file: submission_file ${file.id} (${relative})`);
    }
    hash.update(`F\0${relative}\0`);
    hash.update(fs.readFileSync(lexical));
  }
  return hash.digest("hex");
}

async function snapshotSourcesReadOnly(sources, directory) {
  await fsp.mkdir(directory, { recursive: true });
  const snapshots = {};
  for (const service of SERVICES) {
    const snapshotPath = path.join(directory, `${service}.db`);
    const source = new Database(sources[service], { readonly: true, fileMustExist: true });
    try {
      // Import code only ever attaches these private snapshots. Even an
      // accidental mutating statement therefore cannot touch a legacy source.
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }
    snapshots[service] = snapshotPath;
  }
  return snapshots;
}

function fileIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function removeOwnedPath(target, identity, { recursive = false } = {}) {
  if (!identity) return;
  try {
    const actual = fileIdentity(await fsp.lstat(target));
    if (sameIdentity(actual, identity)) {
      await fsp.rm(target, { recursive, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function publicationExistsError(target) {
  return new Error(`migration publication target already exists: ${target}`);
}

async function publishFileNoClobber(source, target, recordOwnership) {
  const identity = fileIdentity(await fsp.lstat(source));
  try {
    // link(2) is an atomic create-if-absent operation. Unlike rename(2), it
    // cannot replace a destination that appeared after the startup checks.
    await fsp.link(source, target);
  } catch (error) {
    if (error.code === "EEXIST") throw publicationExistsError(target);
    throw error;
  }
  recordOwnership(identity);
  await fsp.unlink(source);
}

async function publishDirectoryNoClobber(source, target, recordOwnership) {
  const sourceStat = await fsp.lstat(source);
  try {
    // Node does not expose renameat2(RENAME_NOREPLACE) for directories. Claim
    // the final name atomically, record that inode as ours, and only then move
    // the staged children into the directory we own.
    await fsp.mkdir(target, { mode: sourceStat.mode });
  } catch (error) {
    if (error.code === "EEXIST") throw publicationExistsError(target);
    throw error;
  }
  recordOwnership(fileIdentity(await fsp.lstat(target)));
  for (const entry of await fsp.readdir(source)) {
    await fsp.rename(path.join(source, entry), path.join(target, entry));
  }
  await fsp.rmdir(source);
}

function assertPublicationTargetsAbsent({ targetPath, reportPath, targetUploads }) {
  if (fs.existsSync(targetPath)) throw publicationExistsError(targetPath);
  if (fs.existsSync(reportPath)) throw publicationExistsError(reportPath);
  if (targetUploads && fs.existsSync(targetUploads)) throw publicationExistsError(targetUploads);
}

export async function migrateLegacyDatabases({
  targetPath,
  sources,
  sourceUploads = null,
  targetUploads = null,
  publicationHook = null,
}) {
  if (!targetPath) throw new Error("target database path is required");
  validateSources(sources);
  if (fs.existsSync(targetPath)) throw new Error(`target database already exists: ${targetPath}`);
  const reportPath = `${targetPath}.migration.json`;
  if (fs.existsSync(reportPath)) throw new Error(`target migration report already exists: ${reportPath}`);
  if ((sourceUploads == null) !== (targetUploads == null)) {
    throw new Error("sourceUploads and targetUploads must be provided together");
  }
  if (targetUploads && fs.existsSync(targetUploads)) {
    throw new Error(`target uploads directory already exists: ${targetUploads}`);
  }
  if (sourceUploads) assertExistingPathComponentsAreNotSymlinks(sourceUploads, "source uploads");

  const sourceGuards = openSourceGuards(sources);
  try {
  const documentFileCount = legacyDocumentFileCount(sourceGuards.documents.db);
  if (!sourceUploads && documentFileCount > 0) {
    throw new Error(
      `legacy document files exist (${documentFileCount} rows); sourceUploads and targetUploads are required`,
    );
  }
  // Open the source read guards before the first await, then reserve the
  // adjacent target name for the full run. A second migration cannot pass the
  // reservation while this process is staging or publishing artifacts.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const token = crypto.randomUUID();
  const reservationPath = `${targetPath}.migration.lock`;
  let reservation = null;
  try {
    const fd = fs.openSync(reservationPath, "wx", 0o600);
    fs.writeFileSync(fd, `${token}\n`);
    reservation = { fd, identity: fileIdentity(fs.fstatSync(fd)) };
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`migration target is already reserved: ${reservationPath}`);
    throw error;
  }
  try {
  // Close the startup-check race between the original existence checks and
  // acquisition of the exclusive reservation.
  assertPublicationTargetsAbsent({ targetPath, reportPath, targetUploads });
  const migrationId = crypto.randomUUID();
  const temporaryPath = `${targetPath}.migrating-${token}`;
  const temporaryUploads = targetUploads ? `${targetUploads}.migrating-${token}` : null;
  const temporarySources = `${targetPath}.sources-${token}`;
  const factoryUploads = `${temporaryPath}.factory-uploads`;
  const temporaryReport = `${reportPath}.migrating-${token}`;
  const report = {
    schemaVersion: 1,
    artifactKind: "legacy-migration",
    migrationId,
    startedAt: new Date().toISOString(),
    sources: Object.fromEntries(SERVICES.map((service) => [service, {
      path: path.resolve(sources[service]),
      sha256: fileSha256(sources[service]),
      bytes: fs.statSync(sources[service]).size,
    }])),
    tables: {},
  };
  let committedDatabaseIdentity = null;
  let committedReportIdentity = null;
  let committedUploadsIdentity = null;
  try {
    const sourceSnapshots = await snapshotSourcesReadOnly(sources, temporarySources);
    for (const service of SERVICES) {
      report.sources[service].snapshotSha256 = fileSha256(sourceSnapshots[service]);
      report.sources[service].snapshotBytes = fs.statSync(sourceSnapshots[service]).size;
    }
    const initialized = createCompetitionApp({
      dbPath: temporaryPath,
      validateUser: async () => ({ valid: true, role: null }),
      skipStaticValidation: true,
      uploadRoot: factoryUploads,
    });
    initialized.close();

    const db = new Database(temporaryPath);
    try {
      db.pragma("foreign_keys = OFF");
      for (const service of SERVICES) attach(db, `legacy_${service}`, sourceSnapshots[service]);
      db.transaction(() => {
        importCanonicalTeams(db, "legacy_entry", report);
        for (const service of SERVICES.filter((name) => name !== "entry")) {
          copyServiceTables(db, `legacy_${service}`, service, report);
        }
        // Factories installed the binding schema before any legacy rows
        // existed. Run the idempotent backfill again after import so tables
        // without INSERT binding triggers (booth/wireless) are covered too.
        installCanonicalTeamReferences(db);
        const inactiveTeams = db.prepare(`
          SELECT id, year, num FROM competition_team
          WHERE active = 0
          ORDER BY year, num
        `).all();
        for (const team of inactiveTeams) clearInactiveTeamLiveState(db, team);
        report.tables["competition.inactive_team_live_state_normalized"] = inactiveTeams.length;
        assertCanonicalTeamReferences(db);
        assignStableSubmissionStorage(db, report);
        for (const service of SERVICES) importLogs(db, `legacy_${service}`, service, report);
        // The empty target factories record their one-time data migrations
        // before legacy rows exist. Clear only the target's migration ledger so
        // the normalization factory pass below applies those migrations to the
        // imported data as well. Source ledgers are never copied or modified.
        db.exec("DELETE FROM schema_migrations");
      })();
      for (const service of [...SERVICES].reverse()) detach(db, `legacy_${service}`);

      const integrity = db.pragma("integrity_check");
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
        throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
      }
      db.pragma("foreign_keys = ON");
      const foreignKeyErrors = db.pragma("foreign_key_check");
      if (foreignKeyErrors.length) {
        throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyErrors.slice(0, 20))}`);
      }
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    // Stage referenced uploads before the runtime normalization pass. Documents
    // startup validates every DB reference synchronously, so the staged DB and
    // staged upload tree must already form one complete unit.
    if (sourceUploads) {
      const sourceUploadSha256 = referencedUploadsSha256(sourceUploads, temporaryPath);
      await fsp.mkdir(path.dirname(temporaryUploads), { recursive: true });
      await copyAndRelocateUploads({
        sourceUploads,
        stagedUploads: temporaryUploads,
        dbPath: temporaryPath,
        report,
      });
      if (referencedUploadsSha256(sourceUploads, temporaryPath) !== sourceUploadSha256) {
        throw new Error("referenced legacy source uploads changed during migration");
      }
      report.uploads.sourceSha256 = sourceUploadSha256;
    }

    // Importing can introduce a schema shape from an older service version
    // (notably Traffic's former per-record tables). Re-run the current module
    // factories against the staged unit so the artifact is already in its final
    // runtime shape before it is hashed or committed.
    const normalized = createCompetitionApp({
      dbPath: temporaryPath,
      validateUser: async () => ({ valid: true, role: null }),
      skipStaticValidation: true,
      uploadRoot: temporaryUploads || factoryUploads,
    });
    normalized.close();
    const checkpointDb = new Database(temporaryPath);
    try {
      checkpointDb.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      checkpointDb.close();
    }
    const validationDb = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      // Migration publishes the same artifact consumed by runtime, backup, and
      // restore. Apply their complete read-only schema, integrity, foreign-key,
      // and canonical-reference contract before any target becomes visible.
      validateCompetitionDatabase(validationDb);
    } finally {
      validationDb.close();
    }

    // Validate the live sources one last time before making any target artifact
    // visible. The audit report is published last, but runtime startup is not
    // coupled to its presence or identity.
    assertSourceGuardsUnchanged(sourceGuards);
    for (const service of SERVICES) {
      const actual = fileSha256(sources[service]);
      if (actual !== report.sources[service].sha256) {
        throw new Error(`legacy source changed during migration: ${service}`);
      }
    }
    report.completedAt = new Date().toISOString();
    report.target = {
      path: path.resolve(targetPath),
      sha256: fileSha256(temporaryPath),
      bytes: fs.statSync(temporaryPath).size,
    };
    await fsp.writeFile(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

    if (temporaryUploads) {
      await publicationHook?.({ kind: "uploads", target: targetUploads });
      await publishDirectoryNoClobber(
        temporaryUploads,
        targetUploads,
        (identity) => { committedUploadsIdentity = identity; },
      );
    }
    await publicationHook?.({ kind: "database", target: targetPath });
    await publishFileNoClobber(
      temporaryPath,
      targetPath,
      (identity) => { committedDatabaseIdentity = identity; },
    );
    await publicationHook?.({ kind: "report", target: reportPath });
    await publishFileNoClobber(
      temporaryReport,
      reportPath,
      (identity) => { committedReportIdentity = identity; },
    );
    await fsp.rm(temporarySources, { recursive: true, force: true });
    await fsp.rm(factoryUploads, { recursive: true, force: true });
    return { ...report, reportPath };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true });
    await fsp.rm(`${temporaryPath}-wal`, { force: true });
    await fsp.rm(`${temporaryPath}-shm`, { force: true });
    if (temporaryUploads) await fsp.rm(temporaryUploads, { recursive: true, force: true });
    await fsp.rm(temporarySources, { recursive: true, force: true });
    await fsp.rm(factoryUploads, { recursive: true, force: true });
    await fsp.rm(temporaryReport, { force: true });
    // Only remove final artifacts whose device/inode identity proves they were
    // published by this run. Foreign destinations that won a race are never
    // deleted during rollback.
    await removeOwnedPath(reportPath, committedReportIdentity);
    await removeOwnedPath(targetPath, committedDatabaseIdentity);
    await removeOwnedPath(targetUploads, committedUploadsIdentity, { recursive: true });
    throw error;
  }
  } finally {
    if (reservation) {
      fs.closeSync(reservation.fd);
      await removeOwnedPath(reservationPath, reservation.identity);
    }
  }
  } finally {
    for (const guard of Object.values(sourceGuards)) guard.db.close();
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--") || i + 1 >= argv.length) throw new Error(`invalid argument: ${key}`);
    values[key.slice(2)] = argv[++i];
  }
  return values;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const sources = Object.fromEntries(SERVICES.map((service) => [service, args[service]]));
    const result = await migrateLegacyDatabases({
      targetPath: args.target,
      sources,
      sourceUploads: args["source-uploads"] || null,
      targetUploads: args["target-uploads"] || null,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[competition-migrate] ${error.stack || error.message || error}`);
    process.exitCode = 1;
  }
}
