import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { setupTestEnv } from "../helpers/test-utils.mjs";

setupTestEnv();
const require = createRequire(import.meta.url);
const Database = require("../../competition/node_modules/better-sqlite3");
const { migrateLegacyDatabases } = await import("../../competition/scripts/migrate.mjs");
const { createCompetitionApp } = await import("../../competition/index.mjs");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtures({ pendingOutbox = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-migrate-test-"));
  roots.push(root);
  const sources = {};
  for (const service of ["entry", "queue", "inspection", "traffic", "score", "documents"]) {
    const dbPath = path.join(root, `${service}.db`);
    sources[service] = dbPath;
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_email TEXT,
      actor_name TEXT,
      actor_role TEXT,
      target TEXT,
      detail TEXT,
      ip TEXT
    )`);
    db.prepare("INSERT INTO logs (timestamp, level, action) VALUES (?, 'info', ?)")
      .run("2026-01-01 00:00:00", `${service}.fixture`);
    if (service === "entry") {
      db.exec(`
        CREATE TABLE entry_2026 (
          num INTEGER PRIMARY KEY, univ TEXT NOT NULL, team TEXT NOT NULL,
          type TEXT, active INTEGER NOT NULL, active_revision INTEGER NOT NULL
        );
        CREATE TABLE vehicle_types_2026 (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL, color TEXT NOT NULL
        );
        CREATE TABLE lifecycle_outbox (id INTEGER PRIMARY KEY);
        INSERT INTO vehicle_types_2026 VALUES (1, 'C-Formula', 0, 'red');
        INSERT INTO entry_2026 VALUES (7, 'Fixture University', 'Fixture Team', 'C-Formula', 0, 9);
      `);
      if (pendingOutbox) db.exec("INSERT INTO lifecycle_outbox VALUES (1)");
    }
    if (service === "queue") {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE inspection (type TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE booth_log (
          id INTEGER PRIMARY KEY, num INTEGER, inspection TEXT, booth_num INTEGER,
          entered_at INTEGER, exited_at INTEGER, created_at INTEGER
        );
      `);
      db.prepare("INSERT INTO settings VALUES ('sms_rank', '8')").run();
    }
    if (service === "inspection") {
      db.exec(`
        CREATE TABLE sheet_template (
          id INTEGER PRIMARY KEY, year INTEGER NOT NULL, level TEXT NOT NULL, name TEXT NOT NULL
        );
        CREATE TABLE sheet_answer (
          year INTEGER NOT NULL, team_num INTEGER NOT NULL, item_id INTEGER NOT NULL,
          PRIMARY KEY (year, team_num, item_id)
        );
      `);
    }
    if (service === "traffic") {
      db.exec(`
        CREATE TABLE event_mode (event_type TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE record_visibility (name TEXT PRIMARY KEY, visible INTEGER NOT NULL DEFAULT 1);
      `);
    }
    if (service === "score") {
      db.exec(`
        CREATE TABLE score_manual (
          year INTEGER NOT NULL, team_num INTEGER NOT NULL, score_type TEXT NOT NULL, value REAL,
          PRIMARY KEY (year, team_num, score_type)
        );
        CREATE TABLE score_penalty (
          year INTEGER NOT NULL, event_type TEXT NOT NULL,
          cone_penalty REAL NOT NULL DEFAULT 0, oc_penalty REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (year, event_type)
        );
      `);
    }
    if (service === "documents") {
      db.exec(`
        CREATE TABLE session (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, notice TEXT DEFAULT '',
          start_at TEXT NOT NULL, end_at TEXT NOT NULL, late_end_at TEXT NOT NULL,
          max_file_size INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
          year INTEGER NOT NULL, allowed_extensions TEXT DEFAULT ''
        );
        CREATE TABLE session_team (
          session_id INTEGER NOT NULL, team_num INTEGER NOT NULL,
          PRIMARY KEY (session_id, team_num)
        );
        CREATE TABLE student_team (
          email TEXT NOT NULL, team_num INTEGER NOT NULL, year INTEGER NOT NULL,
          PRIMARY KEY (email, year), UNIQUE(team_num, year)
        );
        CREATE TABLE submission (
          id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, team_num INTEGER NOT NULL,
          submitted_by TEXT NOT NULL, started_at TEXT DEFAULT '', submitted_at TEXT NOT NULL,
          total_size INTEGER NOT NULL, is_late INTEGER NOT NULL, attempt_no INTEGER NOT NULL
        );
        CREATE TABLE submission_file (
          id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL, original_name TEXT NOT NULL,
          stored_name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT DEFAULT '',
          text_charset TEXT DEFAULT ''
        );
        INSERT INTO session VALUES (
          1, 'Fixture Documents', '', '2026-01-01T00:00:00.000Z',
          '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
          52428800, 'admin@test.invalid', '2026-01-01T00:00:00.000Z', 2026, '.pdf'
        );
        INSERT INTO session_team VALUES (1, 7);
        INSERT INTO student_team VALUES ('student@test.invalid', 7, 2026);
        INSERT INTO submission VALUES (
          11, 1, 7, 'student@test.invalid', '2026-01-02T00:00:00.000Z',
          '2026-01-02T00:01:00.000Z', 7, 0, 1
        );
        INSERT INTO submission_file VALUES (21, 11, 'fixture.pdf', 'stored.pdf', 7, 'application/pdf', '');
      `);
    }
    db.close();
  }
  const sourceUploads = path.join(root, "documents-uploads");
  fs.mkdirSync(path.join(sourceUploads, "1", "7", "11"), { recursive: true });
  fs.writeFileSync(path.join(sourceUploads, "1", "7", "11", "stored.pdf"), "fixture");
  return {
    root,
    sources,
    target: path.join(root, "target", "competition.db"),
    sourceUploads,
    targetUploads: path.join(root, "target", "uploads"),
  };
}

describe("legacy database migration", () => {
  it("creates a new canonical database without changing any source", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const before = Object.fromEntries(Object.entries(sources).map(([name, file]) => [name, fs.statSync(file).size]));
    const report = await migrateLegacyDatabases({
      targetPath: target, sources, sourceUploads, targetUploads,
    });

    assert.ok(fs.existsSync(target));
    assert.ok(fs.existsSync(report.reportPath));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.artifactKind, "legacy-migration");
    assert.match(report.migrationId, /^[0-9a-f-]{36}$/);
    assert.match(report.sources.entry.snapshotSha256, /^[a-f0-9]{64}$/);
    for (const [name, file] of Object.entries(sources)) assert.equal(fs.statSync(file).size, before[name]);

    const db = new Database(target, { readonly: true });
    const team = db.prepare("SELECT id, year, num, univ, name, active FROM competition_team").get();
    assert.deepEqual(team, {
      id: 1,
      year: 2026,
      num: 7,
      univ: "Fixture University",
      name: "Fixture Team",
      active: 0,
    });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'sms_rank'").get().value, "8");
    const modules = db.prepare("SELECT module, COUNT(*) AS count FROM logs GROUP BY module ORDER BY module").all();
    assert.equal(modules.length, 6);
    assert.ok(modules.every((row) => row.count >= 1));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM logs WHERE timestamp = ?")
      .get("2026-01-01T00:00:00.000Z").count, 6);
    assert.equal(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE name = 'competition_migration_identity'",
    ).get(), undefined);
    assert.equal(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_vehicle_class'",
    ).get(), undefined);
    assert.equal(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE name = 'competition_year_version'",
    ).get(), undefined);
    assert.equal(db.pragma("integrity_check")[0].integrity_check, "ok");
    db.close();
    assert.equal(report.uploads.referencedFiles, 1);

    const runtime = createCompetitionApp({
      dbPath: target,
      uploadRoot: targetUploads,
      skipStaticValidation: true,
    });
    runtime.close();
  });

  it("clears live Queue and Traffic state for teams already inactive at cutover", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const queue = new Database(sources.queue);
    queue.exec(`
      CREATE TABLE inspection_queue (
        inspection TEXT NOT NULL, num INTEGER NOT NULL, phone TEXT NOT NULL,
        timestamp INTEGER NOT NULL, year INTEGER NOT NULL,
        PRIMARY KEY (inspection, num, year)
      );
      INSERT INTO inspection_queue VALUES ('battery', 7, '01000000000', 1, 2026);
      CREATE TABLE inspection_history (
        num INTEGER NOT NULL, inspection TEXT NOT NULL, timestamp INTEGER NOT NULL,
        year INTEGER NOT NULL, PRIMARY KEY (num, inspection, year, timestamp)
      );
      INSERT INTO inspection_history VALUES (7, 'battery', 1, 2026);
      CREATE TABLE booth (
        inspection TEXT, booth_num INTEGER, active INTEGER DEFAULT 1,
        occupied_by INTEGER, entered_at INTEGER,
        PRIMARY KEY (inspection, booth_num)
      );
      INSERT INTO booth VALUES ('battery', 1, 1, 7, 1);
    `);
    queue.close();

    const traffic = new Database(sources.traffic);
    traffic.exec(`
      CREATE TABLE wireless_session (
        event_type TEXT PRIMARY KEY, armed INTEGER NOT NULL DEFAULT 0,
        light_color TEXT NOT NULL DEFAULT 'off', team_json TEXT, event_name TEXT
      );
      INSERT INTO wireless_session VALUES (
        '가속', 1, 'green', '{"id":1,"teamId":1,"num":7}', 'FSK 2026 Accel'
      );
    `);
    traffic.close();

    const report = await migrateLegacyDatabases({
      targetPath: target, sources, sourceUploads, targetUploads,
    });
    const db = new Database(target, { readonly: true });
    assert.equal(db.prepare("SELECT active FROM competition_team WHERE id = 1").get().active, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inspection_queue").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inspection_history").get().count, 1);
    assert.deepEqual(db.prepare(`
      SELECT occupied_by, occupied_team_id, entered_at
      FROM booth WHERE inspection = 'battery' AND booth_num = 1
    `).get(), { occupied_by: null, occupied_team_id: null, entered_at: null });
    assert.deepEqual(db.prepare(`
      SELECT armed, light_color, team_id, team_json, event_name
      FROM wireless_session WHERE event_type = '가속'
    `).get(), {
      armed: 0,
      light_color: "off",
      team_id: null,
      team_json: null,
      event_name: null,
    });
    assert.equal(report.tables["competition.inactive_team_live_state_normalized"], 1);
    db.close();
  });

  it("does not bind runtime startup to an audit report", () => {
    const { target } = fixtures();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const runtime = createCompetitionApp({ dbPath: target, skipStaticValidation: true });
    runtime.close();
  });

  it("does not copy legacy lifecycle outboxes", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures({ pendingOutbox: true });
    await migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads });
    const db = new Database(target, { readonly: true });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lifecycle_outbox'").get(), undefined);
    db.close();
  });

  it("rejects duplicate source database identities before creating the target", async () => {
    const { root, sources, target } = fixtures();
    const duplicateInspection = path.join(root, "duplicate-inspection.db");
    fs.linkSync(sources.queue, duplicateInspection);
    sources.inspection = duplicateInspection;
    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources }),
      /source databases must be distinct: inspection and queue/,
    );
    assert.equal(fs.existsSync(target), false);
  });

  it("rejects a distinct file with the wrong service schema before creating the target", async () => {
    const { root, sources, target } = fixtures();
    const wrongInspection = path.join(root, "wrong-inspection.db");
    fs.copyFileSync(sources.queue, wrongInspection);
    sources.inspection = wrongInspection;
    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources }),
      /source database for inspection does not match the expected schema/,
    );
    assert.equal(fs.existsSync(target), false);
  });

  it("does not copy legacy document renumber work", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const documents = new Database(sources.documents);
    documents.exec("CREATE TABLE team_renumber_file_work (id INTEGER PRIMARY KEY)");
    documents.exec("INSERT INTO team_renumber_file_work VALUES (1)");
    documents.close();
    await migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads });
    const db = new Database(target, { readonly: true });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_renumber_file_work'").get(), undefined);
    db.close();
  });

  it("rejects an unexpected copied source table before publishing any artifact", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const queue = new Database(sources.queue);
    queue.exec(`
      CREATE TABLE obsolete_queue_state (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      INSERT INTO obsolete_queue_state VALUES (1, 'legacy-only');
    `);
    queue.close();

    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads }),
      /complete-schema<contract:/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.migration.json`), false);
    assert.equal(fs.existsSync(targetUploads), false);
    const source = new Database(sources.queue, { readonly: true });
    assert.equal(source.prepare("SELECT payload FROM obsolete_queue_state WHERE id = 1").get().payload, "legacy-only");
    source.close();
  });

  it("detects a source commit that only advances the SQLite WAL", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const writer = new Database(sources.queue);
    writer.pragma("journal_mode = WAL");
    const migration = migrateLegacyDatabases({
      targetPath: target, sources, sourceUploads, targetUploads,
    });
    // migrateLegacyDatabases opens its long-lived read guards before its first
    // await, so this commit is guaranteed to occur after the baseline version.
    writer.prepare("INSERT INTO logs (timestamp, level, action) VALUES (?, 'info', ?)")
      .run("2026-01-01T00:00:01.000Z", "queue.concurrent_write");
    try {
      await assert.rejects(migration, /legacy source changed during migration: queue/);
    } finally {
      writer.close();
    }
    assert.equal(fs.existsSync(target), false);
  });

  it("holds an exclusive adjacent reservation for the full migration", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const first = migrateLegacyDatabases({
      targetPath: target, sources, sourceUploads, targetUploads,
    });
    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads }),
      /migration target is already reserved/,
    );
    await first;
    assert.equal(fs.existsSync(`${target}.migration.lock`), false);
  });

  for (const racedKind of ["uploads", "database", "report"]) {
    it(`does not overwrite or delete a foreign ${racedKind} destination created at publication`, async () => {
      const { sources, target, sourceUploads, targetUploads } = fixtures();
      const reportPath = `${target}.migration.json`;
      const foreignTarget = racedKind === "uploads"
        ? targetUploads
        : racedKind === "database" ? target : reportPath;
      const foreignMarker = racedKind === "uploads"
        ? path.join(foreignTarget, "foreign.txt")
        : foreignTarget;
      const foreignContent = `foreign ${racedKind}`;

      await assert.rejects(
        migrateLegacyDatabases({
          targetPath: target,
          sources,
          sourceUploads,
          targetUploads,
          publicationHook: ({ kind }) => {
            if (kind !== racedKind) return;
            if (racedKind === "uploads") fs.mkdirSync(foreignTarget);
            fs.writeFileSync(foreignMarker, foreignContent);
          },
        }),
        /migration publication target already exists/,
      );

      assert.equal(fs.readFileSync(foreignMarker, "utf8"), foreignContent);
      if (racedKind !== "database") assert.equal(fs.existsSync(target), false);
      if (racedKind !== "report") assert.equal(fs.existsSync(reportPath), false);
      if (racedKind !== "uploads") assert.equal(fs.existsSync(targetUploads), false);
      assert.equal(fs.existsSync(`${target}.migration.lock`), false);
      assert.deepEqual(
        fs.readdirSync(path.dirname(target)).filter((name) => name.includes(".migrating-") || name.includes(".sources-")),
        [],
      );
    });
  }

  it("requires upload paths when legacy file metadata exists", async () => {
    const { sources, target } = fixtures();
    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources }),
      /legacy document files exist \(1 rows\).*sourceUploads and targetUploads are required/,
    );
    assert.equal(fs.existsSync(target), false);
  });

  it("relocates legacy document files to stable team-ID paths without changing the source", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const sourceFile = path.join(sourceUploads, "1", "7", "11", "stored.pdf");
    const report = await migrateLegacyDatabases({
      targetPath: target,
      sources,
      sourceUploads,
      targetUploads,
    });

    const db = new Database(target, { readonly: true });
    const submission = db.prepare("SELECT id, team_id, storage_dir FROM submission WHERE id = 11").get();
    db.close();
    assert.deepEqual(submission, { id: 11, team_id: 1, storage_dir: "1/team-1/11" });
    assert.equal(fs.readFileSync(path.join(targetUploads, submission.storage_dir, "stored.pdf"), "utf8"), "fixture");
    assert.equal(fs.existsSync(path.join(targetUploads, "1", "7", "11")), false);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "fixture");
    assert.equal(report.uploads.copiedReferencedFiles, 1);
    assert.equal(report.uploads.unreferencedFilesCopied, 0);
    assert.match(report.uploads.sourceSha256, /^[a-f0-9]{64}$/);
  });

  it("ignores unreferenced legacy upload symlinks", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    fs.symlinkSync("stored.pdf", path.join(sourceUploads, "1", "7", "11", "linked.pdf"));
    const report = await migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads });
    assert.equal(report.uploads.copiedReferencedFiles, 1);
    assert.equal(report.uploads.unreferencedFilesCopied, 0);
    assert.equal(fs.existsSync(path.join(targetUploads, "1", "team-1", "11", "linked.pdf")), false);
  });

  it("rejects a configured legacy upload root that is a symbolic link", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const realUploads = `${sourceUploads}-real`;
    fs.renameSync(sourceUploads, realUploads);
    fs.symlinkSync(realUploads, sourceUploads, "dir");

    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads }),
      /source uploads path contains a symbolic link/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.migration.json`), false);
    assert.equal(fs.existsSync(targetUploads), false);
    assert.equal(fs.readFileSync(path.join(realUploads, "1", "7", "11", "stored.pdf"), "utf8"), "fixture");
  });

  it("rejects a legacy upload root beneath a symbolic-link ancestor", async () => {
    const { root, sources, target, sourceUploads, targetUploads } = fixtures();
    const realParent = path.join(root, "real-upload-parent");
    const linkedParent = path.join(root, "linked-upload-parent");
    fs.mkdirSync(realParent);
    fs.renameSync(sourceUploads, path.join(realParent, "uploads"));
    fs.symlinkSync(realParent, linkedParent, "dir");
    const linkedUploads = path.join(linkedParent, "uploads");

    await assert.rejects(
      migrateLegacyDatabases({
        targetPath: target,
        sources,
        sourceUploads: linkedUploads,
        targetUploads,
      }),
      /source uploads path contains a symbolic link/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.migration.json`), false);
    assert.equal(fs.existsSync(targetUploads), false);
    assert.equal(
      fs.readFileSync(path.join(realParent, "uploads", "1", "7", "11", "stored.pdf"), "utf8"),
      "fixture",
    );
  });

  it("accepts a real nested legacy upload root and referenced regular file", async () => {
    const { root, sources, target, sourceUploads, targetUploads } = fixtures();
    const nestedRoot = path.join(root, "real", "nested", "uploads");
    fs.mkdirSync(path.dirname(nestedRoot), { recursive: true });
    fs.renameSync(sourceUploads, nestedRoot);

    await migrateLegacyDatabases({
      targetPath: target,
      sources,
      sourceUploads: nestedRoot,
      targetUploads,
    });
    assert.equal(fs.readFileSync(path.join(targetUploads, "1", "team-1", "11", "stored.pdf"), "utf8"), "fixture");
    assert.equal(fs.readFileSync(path.join(nestedRoot, "1", "7", "11", "stored.pdf"), "utf8"), "fixture");
  });

  it("rejects missing files referenced by submission_file metadata", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    fs.unlinkSync(path.join(sourceUploads, "1", "7", "11", "stored.pdf"));
    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads }),
      /referenced upload is missing: submission_file 21/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(targetUploads), false);
  });

  it("normalizes legacy Traffic record tables before committing the target", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const traffic = new Database(sources.traffic);
    traffic.exec(`
      CREATE TABLE 'FSK 2026 Accel' (
        time TEXT, num INTEGER, univ TEXT, team TEXT, type TEXT, result INTEGER,
        detail TEXT, invalidated INTEGER DEFAULT 0, scoreboard INTEGER DEFAULT 1,
        cones INTEGER DEFAULT 0, oc INTEGER DEFAULT 0
      );
      INSERT INTO 'FSK 2026 Accel'
      VALUES ('2026-01-01T00:00:00.000Z', 7, 'Fixture University', 'Fixture Team',
              '가속', 1234, NULL, 0, 1, 0, 0);
      INSERT INTO 'FSK 2026 Accel'
      VALUES ('2026-01-01T00:00:01.000Z', 7, 'Fixture University', 'Fixture Team',
              '가속', 9999, NULL, 0, 1, 0, 0);
      INSERT INTO 'FSK 2026 Accel'
      VALUES ('2026-01-01T00:00:02.000Z', 7, 'Fixture University', 'Fixture Team',
              '가속', 5678, NULL, 0, 1, 0, 0);
      DELETE FROM 'FSK 2026 Accel' WHERE rowid = 2;
      CREATE TABLE wireless_session (
        event_type TEXT PRIMARY KEY,
        saved_record_name TEXT,
        saved_record_rowid INTEGER
      );
      INSERT INTO wireless_session VALUES ('가속', 'FSK 2026 Accel', 3);
    `);
    traffic.close();

    await migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads });
    const db = new Database(target, { readonly: true });
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'FSK 2026 Accel'",
    ).get().count, 0);
    assert.deepEqual(db.prepare(
      "SELECT name, legacy_rowid, num, result, team_id FROM record WHERE name = 'FSK 2026 Accel' ORDER BY legacy_rowid",
    ).all(), [
      { name: "FSK 2026 Accel", legacy_rowid: 1, num: 7, result: 1234, team_id: 1 },
      { name: "FSK 2026 Accel", legacy_rowid: 3, num: 7, result: 5678, team_id: 1 },
    ]);
    assert.deepEqual(db.prepare(
      "SELECT saved_record_name, saved_record_rowid FROM wireless_session WHERE event_type = '가속'",
    ).get(), { saved_record_name: "FSK 2026 Accel", saved_record_rowid: 3 });
    db.close();
  });

  it("refuses operational module rows that cannot bind to a canonical team", async () => {
    const { sources, target, sourceUploads, targetUploads } = fixtures();
    const score = new Database(sources.score);
    score.exec(`
      INSERT INTO score_manual VALUES (2026, 999, 'orphan', 1);
    `);
    score.close();

    await assert.rejects(
      migrateLegacyDatabases({ targetPath: target, sources, sourceUploads, targetUploads }),
      /unknown competition team|unbound canonical team references/,
    );
    assert.equal(fs.existsSync(target), false);
    const source = new Database(sources.score, { readonly: true });
    assert.equal(source.prepare("SELECT value FROM score_manual WHERE team_num = 999").get().value, 1);
    source.close();
  });
});
