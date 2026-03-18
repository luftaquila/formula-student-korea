import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

export function createEntryApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/entry.db");

// 차량 유형 테이블 (전역, 연도 무관)
db.exec(`CREATE TABLE IF NOT EXISTS vehicle_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
)`);

// 기존 entry 테이블이 있으면 올해 테이블로 마이그레이션
const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry'").get();
if (legacy) {
  db.exec(`ALTER TABLE entry RENAME TO entry_${new Date().getFullYear()}`);
}

// 연도별 테이블 헬퍼
function getTableName(year) {
  const y = Number(year) || new Date().getFullYear();
  if (!/^\d{4}$/.test(String(y)) || y < 2000 || y > 2099) {
    throw new Error("올바르지 않은 연도입니다.");
  }
  return `entry_${y}`;
}

function ensureYearTable(year) {
  const tableName = getTableName(year);
  db.exec(`CREATE TABLE IF NOT EXISTS '${tableName}' (
    num INTEGER PRIMARY KEY, univ TEXT NOT NULL, team TEXT NOT NULL, type TEXT DEFAULT NULL
  )`);
  return tableName;
}

function getAvailableYears() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entry_%' ORDER BY name DESC")
    .all()
    .map(t => Number(t.name.replace('entry_', '')))
    .filter(y => !isNaN(y));
}

// 올해 테이블 보장
ensureYearTable(new Date().getFullYear());

// 기존 테이블에 type 컬럼 마이그레이션
for (const year of getAvailableYears()) {
  const tableName = getTableName(year);
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN type TEXT DEFAULT NULL`); }
  catch (e) { /* column already exists */ }
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "entry");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/years") return null;
  if (req.path === "/api/entries" && req.method === "GET") return null;
  if (req.path === "/api/vehicle-types" && req.method === "GET") return null;
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateEntryNum(num) {
  const parsed = Number(num);
  if (num === "" || num === undefined || Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    return { valid: false, error: "올바르지 않은 엔트리 번호입니다." };
  }
  return { valid: true, value: parsed };
}

function validateEntryData({ univ, team, type }) {
  if (typeof univ !== "string" || univ.trim() === "") {
    return { valid: false, error: "올바르지 않은 학교명입니다." };
  }
  if (typeof team !== "string" || team.trim() === "") {
    return { valid: false, error: "올바르지 않은 팀명입니다." };
  }
  const validatedType = type || null;
  if (validatedType) {
    const exists = db.prepare("SELECT id FROM vehicle_types WHERE name = ?").get(validatedType);
    if (!exists) {
      return { valid: false, error: "존재하지 않는 차량 유형입니다." };
    }
  }
  return { valid: true, univ: univ.trim(), team: team.trim(), type: validatedType };
}

function validateBulkData(data) {
  let parsed;

  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { valid: false, error: `JSON 파일을 읽을 수 없습니다: ${e}` };
  }

  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
  }

  for (const key in parsed) {
    if (!/^\d+$/.test(key) || Number(key) < 1) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    const value = parsed[key];
    if (typeof value !== "object" || value === null) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    const keys = Object.keys(value);
    if (!keys.includes("univ") || !keys.includes("team")) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    if (typeof value.univ !== "string" || !value.univ.trim()) {
      return { valid: false, error: `엔트리 ${key}: 올바르지 않은 학교명입니다.` };
    }
    if (typeof value.team !== "string" || !value.team.trim()) {
      return { valid: false, error: `엔트리 ${key}: 올바르지 않은 팀명입니다.` };
    }
  }

  return { valid: true, data: parsed };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   연도/테이블 미들웨어
   ============================================ */
function withYearTable(req, res, next) {
  const year = req.query.year || new Date().getFullYear();
  try {
    req.tableName = ensureYearTable(year);
    req.year = year;
    next();
  } catch (e) {
    return res.status(400).send(e.message);
  }
}

/* ============================================
   API 라우트: /api/years, /api/entries
   ============================================ */

// GET /api/years - 사용 가능한 연도 목록
app.get("/api/years", (req, res) => {
  res.json(getAvailableYears());
});

// GET /api/entries - 모든 엔트리 조회
app.get("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const result = dbRun(() => {
    const data = {};
    for (const row of db.prepare(`SELECT * FROM '${tableName}'`).all()) {
      data[row.num] = { univ: row.univ, team: row.team, type: row.type };
    }
    return data;
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (req.query.download !== undefined) {
    res.setHeader("Content-Disposition", `attachment; filename="entry_${year}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(result.result, null, 2));
  } else {
    res.json(result.result);
  }
});

// POST /api/entries - 새 엔트리 추가
app.post("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const dataValidation = validateEntryData(req.body);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const result = dbRun(() =>
    db
      .prepare(`INSERT INTO '${tableName}' (num, univ, team, type) VALUES (?, ?, ?, ?)`)
      .run(numValidation.value, dataValidation.univ, dataValidation.team, dataValidation.type),
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.create", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${numValidation.value}`);
  res.status(201).send();
});

// PATCH /api/entries/:num - 엔트리 수정
app.patch("/api/entries/:num", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const prevNumValidation = validateEntryNum(req.params.num);
  if (!prevNumValidation.valid) {
    return res.status(400).send(prevNumValidation.error);
  }

  const newNumValidation = validateEntryNum(req.body.num);
  if (!newNumValidation.valid) {
    return res.status(400).send(newNumValidation.error);
  }

  const dataValidation = validateEntryData(req.body);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const prevNum = prevNumValidation.value;
  const newNum = newNumValidation.value;
  const numChanged = prevNum !== newNum;

  const result = dbRun(() => {
    return db.transaction(() => {
      if (numChanged) {
        const numResult = db.prepare(`UPDATE '${tableName}' SET num = ? WHERE num = ?`).run(newNum, prevNum);
        if (!numResult.changes) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
      }

      const updateResult = db.prepare(`UPDATE '${tableName}' SET univ = ?, team = ?, type = ? WHERE num = ?`)
        .run(dataValidation.univ, dataValidation.team, dataValidation.type, newNum);

      if (!updateResult.changes) {
        throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
      }

      return updateResult;
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.update", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${newNum}`);
  res.status(200).send();
});

// DELETE /api/entries/:num - 엔트리 삭제
app.delete("/api/entries/:num", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const entry = db.prepare(`SELECT univ, team FROM '${tableName}' WHERE num = ?`).get(numValidation.value);
  const result = dbRun(() => db.prepare(`DELETE FROM '${tableName}' WHERE num = ?`).run(numValidation.value));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    return res.status(404).send("존재하지 않는 엔트리 번호입니다.");
  }

  logger.log(req, "entry.delete", { year, univ: entry?.univ, team: entry?.team }, `#${numValidation.value}`);
  res.status(200).send();
});

// DELETE /api/entries - 모든 엔트리 삭제
app.delete("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const result = dbRun(() => db.prepare(`DELETE FROM '${tableName}'`).run());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.delete_all", { year });
  res.status(200).send();
});

// POST /api/entries/bulk - 엔트리 일괄 업로드 (DB 교체)
app.post("/api/entries/bulk", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const validation = validateBulkData(req.body.data);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare(`DELETE FROM '${tableName}'`).run();
      const validTypes = new Set(db.prepare("SELECT name FROM vehicle_types").all().map(t => t.name));
      const query = db.prepare(`INSERT INTO '${tableName}' (num, univ, team, type) VALUES (?, ?, ?, ?)`);
      for (const [k, v] of Object.entries(validation.data)) {
        const validatedType = v.type || null;
        if (validatedType && !validTypes.has(validatedType)) {
          throw { status: 400, message: `엔트리 ${k}: 존재하지 않는 차량 유형 '${validatedType}'` };
        }
        query.run(Number(k), v.univ.trim(), v.team.trim(), validatedType);
      }
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.bulk_upload", { year, count: Object.keys(validation.data).length });
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/vehicle-types
   ============================================ */

// GET /api/vehicle-types - 차량 유형 목록
app.get("/api/vehicle-types", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT * FROM vehicle_types ORDER BY sort_order, id").all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/vehicle-types - 차량 유형 추가
app.post("/api/vehicle-types", (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).send("유형 이름을 입력하세요.");
  }
  const maxOrder = db.prepare("SELECT MAX(sort_order) as max FROM vehicle_types").get();
  const nextOrder = (maxOrder?.max ?? -1) + 1;
  const result = dbRun(() =>
    db.prepare("INSERT INTO vehicle_types (name, sort_order) VALUES (?, ?)").run(name.trim(), nextOrder),
  );
  if (!result.success) {
    if (result.error.includes("UNIQUE")) {
      return res.status(400).send("이미 존재하는 차량 유형입니다.");
    }
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "vehicle_type.create", null, name.trim());
  res.status(201).json({ id: result.result.lastInsertRowid, name: name.trim(), sort_order: nextOrder });
});

// DELETE /api/vehicle-types/:id - 차량 유형 삭제
app.delete("/api/vehicle-types/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).send("올바르지 않은 ID입니다.");

  const type = db.prepare("SELECT name FROM vehicle_types WHERE id = ?").get(id);
  if (!type) return res.status(404).send("존재하지 않는 차량 유형입니다.");

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM vehicle_types WHERE id = ?").run(id);
      for (const year of getAvailableYears()) {
        const tableName = getTableName(year);
        db.prepare(`UPDATE '${tableName}' SET type = NULL WHERE type = ?`).run(type.name);
      }
    })();
  });

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "vehicle_type.delete", null, type.name);
  res.status(200).send();
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createEntryApp();
  setupProcessHandlers(db);
  app.listen(9200);
}
