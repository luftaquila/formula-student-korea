import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDbPath, cleanup, setupTestEnv, TRUST_JWT } from '../helpers/test-utils.mjs';
import { currentCompetitionYear } from '../../shared/competition-year.mjs';

setupTestEnv();

import { createInspectionApp } from '../../inspection/index.mjs';

const requireFromInspection = createRequire(new URL('../../inspection/package.json', import.meta.url));
const Database = requireFromInspection('better-sqlite3');

describe('Automatic inspector migration', () => {
  it('replaces manual names with all recoverable authenticated editors exactly once', () => {
    const year = currentCompetitionYear();
    const dbPath = tmpDbPath();
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE sheet_template (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
        parent_id INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable', 'counter', 'stopwatch') OR answer_type IS NULL),
        remarks TEXT DEFAULT '',
        unit TEXT DEFAULT '',
        pdf_include INTEGER DEFAULT 1,
        excluded_types TEXT DEFAULT '',
        field_key TEXT DEFAULT '',
        calculation TEXT DEFAULT '',
        FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
      );
      INSERT INTO sheet_template (id, year, level, name) VALUES
        (1, ${year}, 'category', 'Category');
      INSERT INTO sheet_template (id, year, level, parent_id, name) VALUES
        (2, ${year}, 'subcategory', 1, 'Subcategory'),
        (3, ${year}, 'group', 2, 'Group');
      INSERT INTO sheet_template (id, year, level, parent_id, name, answer_type) VALUES
        (4, ${year}, 'item', 3, 'Item', 'passfail');

      CREATE TABLE sheet_answer (
        year INTEGER NOT NULL,
        team_num INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        value TEXT DEFAULT '',
        memo TEXT DEFAULT '',
        answer_updated_at TEXT,
        answer_updated_by TEXT,
        memo_updated_at TEXT,
        memo_updated_by TEXT,
        PRIMARY KEY (year, team_num, item_id),
        FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
      );
      INSERT INTO sheet_answer VALUES
        (${year}, 7, 4, 'PASS', 'memo',
         '2026-08-02T01:00:00.000Z', 'Last Answer Editor',
         '2026-08-03T01:00:00.000Z', 'Last Memo Editor');

      CREATE TABLE sheet_inspector (
        year INTEGER NOT NULL,
        team_num INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        inspector TEXT DEFAULT '',
        PRIMARY KEY (year, team_num, category_id),
        FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
      );
      INSERT INTO sheet_inspector VALUES (${year}, 7, 1, 'Manually Typed Name');

      CREATE TABLE logs (
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
      );
      INSERT INTO logs
        (timestamp, level, action, actor_name, target, detail)
      VALUES
        ('2026-08-01T01:00:00.000Z', 'info', 'answer.update', 'Earlier Editor', '#7',
         '{"year":${year},"item_id":4,"value":"FAIL"}'),
        ('2026-07-31T01:00:00.000Z', 'info', 'answer.update', 'Malformed Log Editor', '#7',
         'not-json');
    `);
    legacyDb.close();

    let firstApp;
    let secondApp;
    try {
      firstApp = createInspectionApp({ dbPath, validateUser: TRUST_JWT });
      const migrated = JSON.parse(firstApp.db.prepare(
        'SELECT inspector FROM sheet_inspector WHERE year = ? AND team_num = 7 AND category_id = 1',
      ).get(year).inspector);
      assert.deepEqual(migrated, ['Earlier Editor', 'Last Answer Editor', 'Last Memo Editor']);
      assert.equal(migrated.includes('Manually Typed Name'), false);
      firstApp.db.close();
      firstApp = null;

      secondApp = createInspectionApp({ dbPath, validateUser: TRUST_JWT });
      const reopened = JSON.parse(secondApp.db.prepare(
        'SELECT inspector FROM sheet_inspector WHERE year = ? AND team_num = 7 AND category_id = 1',
      ).get(year).inspector);
      assert.deepEqual(reopened, migrated);
      assert.equal(secondApp.db.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'inspection-automatic-inspectors-v1'",
      ).get().count, 1);
    } finally {
      if (firstApp?.db?.open) firstApp.db.close();
      if (secondApp?.db?.open) secondApp.db.close();
      cleanup(dbPath);
    }
  });
});
