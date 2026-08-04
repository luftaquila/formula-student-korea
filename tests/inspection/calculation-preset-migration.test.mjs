import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpDbPath, cleanup, setupTestEnv } from "../helpers/test-utils.mjs";

setupTestEnv();

import { createInspectionApp } from "../../inspection/index.mjs";

const requireFromInspection = createRequire(new URL("../../inspection/package.json", import.meta.url));
const Database = requireFromInspection("better-sqlite3");

describe("inspection startup", () => {
  it("does not insert or rewrite 2026 IMD/TSMP template content", () => {
    const dbPath = tmpDbPath();
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE sheet_template (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
      parent_id INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable', 'counter', 'stopwatch') OR answer_type IS NULL),
      remarks TEXT DEFAULT '', unit TEXT DEFAULT '', pdf_include INTEGER DEFAULT 1, excluded_types TEXT DEFAULT '',
      FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
    )`);
    const insert = seed.prepare(`INSERT INTO sheet_template
      (year, level, parent_id, sort_order, name, answer_type, remarks, unit)
      VALUES (2026, ?, ?, ?, ?, ?, ?, ?)`);
    const accumulator = Number(insert.run("category", null, 0, "축전지", null, "", "").lastInsertRowid);
    const basics = Number(insert.run("subcategory", accumulator, 0, "기본사항", null, "", "").lastInsertRowid);
    const specs = Number(insert.run("group", basics, 0, "차량 제원", null, "", "").lastInsertRowid);
    const maxVoltage = Number(insert.run("item", specs, 0, "TS Voltage (max)", "number", "", "V").lastInsertRowid);
    const inspection = Number(insert.run("subcategory", accumulator, 1, "축전지 검사", null, "", "").lastInsertRowid);
    const info = Number(insert.run("group", inspection, 0, "기본정보", null, "", "").lastInsertRowid);
    const imd = Number(insert.run("item", info, 0, "IMD 테스트 값", "number", "(250 * 현재 전압)", "Ω").lastInsertRowid);
    const tsmp = Number(insert.run("item", info, 1, "TSMP 전류제한 저항값", "number", "ranges", "kΩ").lastInsertRowid);
    seed.close();

    let appDb;
    try {
      appDb = createInspectionApp({ dbPath }).db;
      const current = appDb.prepare("SELECT * FROM sheet_template WHERE parent_id = ? AND name = '현재 TS 전압'").get(info);
      assert.equal(current, undefined);

      const maxRow = appDb.prepare("SELECT field_key, calculation FROM sheet_template WHERE id = ?").get(maxVoltage);
      const imdRow = appDb.prepare("SELECT sort_order, field_key, calculation, remarks, unit FROM sheet_template WHERE id = ?").get(imd);
      const tsmpRow = appDb.prepare("SELECT sort_order, field_key, calculation, remarks, unit FROM sheet_template WHERE id = ?").get(tsmp);
      assert.equal(maxRow.field_key, `item-2026-${maxVoltage}`);
      assert.equal(maxRow.calculation, "");
      assert.deepEqual(imdRow, {
        sort_order: 0,
        field_key: `item-2026-${imd}`,
        calculation: "",
        remarks: "(250 * 현재 전압)",
        unit: "Ω",
      });
      assert.deepEqual(tsmpRow, {
        sort_order: 1,
        field_key: `item-2026-${tsmp}`,
        calculation: "",
        remarks: "ranges",
        unit: "kΩ",
      });
    } finally {
      try { appDb?.close(); } catch {}
      cleanup(dbPath);
    }
  });
});
