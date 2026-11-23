import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createCourseApp } from "../../course/index.mjs";
import { validateSupportDatabaseFile } from "../../competition/scripts/validate-support-database.mjs";
import { tmpDbPath, setupTestEnv, TRUST_JWT, cleanup } from "../helpers/test-utils.mjs";

setupTestEnv();
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function withCourseDatabase(fn) {
  const dbPath = tmpDbPath();
  let created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
  try {
    fn(created.db, dbPath, () => {
      created.close(); created.db.close();
      created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
      return created.db;
    });
  } finally { created.close(); created.db.close(); cleanup(dbPath); }
}

// Validation must accept the artifact as-is and never write to it.
function assertValidReadOnly(db, dbPath) {
  db.pragma("wal_checkpoint(TRUNCATE)");
  const before = digest(dbPath);
  assert.equal(validateSupportDatabaseFile("course", dbPath), true);
  assert.equal(digest(dbPath), before);
}

function revertToFlagColumn(db) {
  db.exec("DROP TABLE course_publication");
  db.exec("ALTER TABLE course ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1))");
}

test("backup validation accepts the publication table and rejects orphaned rows without changing the source", () => {
  withCourseDatabase((db, dbPath) => {
    db.exec("INSERT INTO course (name) VALUES ('Private'), ('Public')");
    db.exec("INSERT INTO course_publication (course_id) VALUES (2)");
    assertValidReadOnly(db, dbPath);
    db.pragma("foreign_keys = OFF");
    db.exec("INSERT INTO course_publication (course_id) VALUES (99)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const invalid = digest(dbPath);
    assert.throws(() => validateSupportDatabaseFile("course", dbPath), /foreign/i);
    assert.equal(digest(dbPath), invalid);
  });
});

test("backups that store publication on the course row remain valid read-only and migrate at runtime", () => {
  withCourseDatabase((db, dbPath, restart) => {
    db.exec("INSERT INTO course (name) VALUES ('Private'), ('Public')");
    revertToFlagColumn(db);
    db.prepare("UPDATE course SET is_public = 1 WHERE name = 'Public'").run();
    assertValidReadOnly(db, dbPath);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE course SET is_public = 2 WHERE name = 'Public'").run();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const invalid = digest(dbPath);
    assert.throws(() => validateSupportDatabaseFile("course", dbPath), /integrity_check|publication state/);
    assert.equal(digest(dbPath), invalid);
    db.prepare("UPDATE course SET is_public = 1 WHERE name = 'Public'").run();
    db.prepare("DELETE FROM schema_migrations WHERE name = 'course.publication_table.v1'").run();
    const migrated = restart();
    assert.deepEqual(migrated.prepare("SELECT course_id FROM course_publication").all(), [{ course_id: 2 }]);
    assert.equal(migrated.pragma("table_info(course)").some((column) => column.name === "is_public"), false);
  });
});

test("the exact pre-publication backup remains valid read-only and gets private defaults only at runtime", () => {
  withCourseDatabase((db, dbPath, restart) => {
    db.exec("INSERT INTO course (name) VALUES ('Before publication')");
    db.exec("DROP TABLE course_publication");
    assertValidReadOnly(db, dbPath);
    db.exec("ALTER TABLE course ADD COLUMN unexpected TEXT");
    assert.throws(() => validateSupportDatabaseFile("course", dbPath), /schema/);
    db.exec("ALTER TABLE course DROP COLUMN unexpected");
    db.prepare("DELETE FROM schema_migrations WHERE name = 'course.publication_table.v1'").run();
    const migrated = restart();
    assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM course_publication").get().n, 0);
  });
});
