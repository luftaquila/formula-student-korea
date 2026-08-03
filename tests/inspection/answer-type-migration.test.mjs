import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDbPath, cleanup, setupTestEnv } from '../helpers/test-utils.mjs';

setupTestEnv();

import { createInspectionApp } from '../../inspection/index.mjs';

const requireFromInspection = createRequire(new URL('../../inspection/package.json', import.meta.url));
const Database = requireFromInspection('better-sqlite3');

describe('Inspection answer-type migration', () => {
  it('adds counter and stopwatch while preserving existing template metadata', () => {
    const dbPath = tmpDbPath();
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`CREATE TABLE sheet_template (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
      parent_id INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable') OR answer_type IS NULL),
      remarks TEXT DEFAULT '',
      unit TEXT DEFAULT '',
      pdf_include INTEGER DEFAULT 1,
      excluded_types TEXT DEFAULT '',
      FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
    )`);
    const categoryId = legacyDb.prepare(`INSERT INTO sheet_template
      (year, level, name, remarks, unit, pdf_include, excluded_types)
      VALUES (?, 'category', ?, ?, ?, ?, ?)`
    ).run(2026, 'Legacy category', 'Legacy remarks', 'legacy-unit', 0, '["EV"]').lastInsertRowid;
    const itemId = legacyDb.prepare(`INSERT INTO sheet_template
      (year, level, parent_id, name, answer_type)
      VALUES (?, 'item', ?, ?, 'text')`
    ).run(2026, categoryId, 'Legacy item').lastInsertRowid;
    legacyDb.exec(`CREATE TABLE sheet_answer (
      year INTEGER NOT NULL,
      team_num INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      value TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      answer_version INTEGER NOT NULL DEFAULT 0,
      answer_updated_at TEXT,
      answer_updated_by TEXT,
      memo_version INTEGER NOT NULL DEFAULT 0,
      memo_updated_at TEXT,
      memo_updated_by TEXT,
      PRIMARY KEY (year, team_num, item_id),
      FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
    )`);
    legacyDb.prepare("INSERT INTO sheet_answer (year, team_num, item_id, value) VALUES (?, ?, ?, ?)")
      .run(2026, 1, itemId, 'preserved answer');
    legacyDb.close();

    let migratedDb;
    try {
      migratedDb = createInspectionApp({ dbPath }).db;
      const schema = migratedDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sheet_template'"
      ).get().sql;
      assert.match(schema, /'counter'/);
      assert.match(schema, /'stopwatch'/);

      const row = migratedDb.prepare("SELECT * FROM sheet_template WHERE name = 'Legacy category'").get();
      assert.equal(row.remarks, 'Legacy remarks');
      assert.equal(row.unit, 'legacy-unit');
      assert.equal(row.pdf_include, 0);
      assert.equal(row.excluded_types, '["EV"]');
      assert.equal(
        migratedDb.prepare("SELECT value FROM sheet_answer WHERE item_id = ?").get(itemId).value,
        'preserved answer',
      );
      assert.deepEqual(migratedDb.pragma('foreign_key_check'), []);

      assert.doesNotThrow(() => {
        migratedDb.prepare(`INSERT INTO sheet_template
          (year, level, name, answer_type) VALUES (?, 'item', ?, 'counter')`
        ).run(2026, 'Counter item');
        migratedDb.prepare(`INSERT INTO sheet_template
          (year, level, name, answer_type) VALUES (?, 'item', ?, 'stopwatch')`
        ).run(2026, 'Stopwatch item');
      });
    } finally {
      migratedDb?.close();
      cleanup(dbPath);
    }
  });
});
