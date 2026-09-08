import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createCourseApp } from "../../course/index.mjs";
import { validateSupportDatabaseFile } from "../../competition/scripts/validate-support-database.mjs";
import { tmpDbPath, setupTestEnv, TRUST_JWT, cleanup } from "../helpers/test-utils.mjs";

setupTestEnv();
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("backup validation preserves publication flags and rejects invalid values without changing the source", () => {
  const dbPath = tmpDbPath();
  const created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
  try {
    created.db.exec("INSERT INTO course (name, is_public) VALUES ('Private', 0), ('Public', 1)");
    created.db.pragma("wal_checkpoint(TRUNCATE)");
    const before = digest(dbPath);
    assert.equal(validateSupportDatabaseFile("course", dbPath), true);
    assert.equal(digest(dbPath), before);
    assert.deepEqual(created.db.prepare("SELECT is_public FROM course ORDER BY id").all(), [{ is_public: 0 }, { is_public: 1 }]);
    created.db.pragma("ignore_check_constraints = ON");
    created.db.prepare("UPDATE course SET is_public = 2 WHERE name = 'Public'").run();
    created.db.pragma("wal_checkpoint(TRUNCATE)");
    const invalid = digest(dbPath);
    assert.throws(() => validateSupportDatabaseFile("course", dbPath), /integrity_check|publication state/);
    assert.equal(digest(dbPath), invalid);
  } finally { created.close(); created.db.close(); cleanup(dbPath); }
});

test("the exact pre-publication backup remains valid read-only and gets private defaults only at runtime", () => {
  const dbPath = tmpDbPath();
  let created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
  try {
    created.db.exec("INSERT INTO course (name) VALUES ('Before publication')");
    created.db.exec("ALTER TABLE course DROP COLUMN is_public");
    created.db.pragma("wal_checkpoint(TRUNCATE)");
    const before = digest(dbPath);
    assert.equal(validateSupportDatabaseFile("course", dbPath), true);
    assert.equal(digest(dbPath), before);
    assert.equal(created.db.pragma("table_info(course)").some((column) => column.name === "is_public"), false);
    created.db.exec("ALTER TABLE course ADD COLUMN unexpected TEXT");
    assert.throws(() => validateSupportDatabaseFile("course", dbPath), /schema/);
    created.db.exec("ALTER TABLE course DROP COLUMN unexpected");
    created.close(); created.db.close();
    created = createCourseApp({ dbPath, validateUser: TRUST_JWT });
    assert.equal(created.db.prepare("SELECT is_public FROM course").get().is_public, 0);
  } finally { created.close(); created.db.close(); cleanup(dbPath); }
});
