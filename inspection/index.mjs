import express from "express";
import Database from "better-sqlite3";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

/* ============================================
   Database 초기화
   ============================================ */
ensureDataDir();

const db = new Database("./data/sheet.db");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// answer_type CHECK 제약조건에 'checktable' 추가 마이그레이션
// FK CASCADE 문제를 피하기 위해 트랜잭션 밖에서 foreign_keys OFF 상태로 실행
{
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sheet_template'").get();
  if (schema && !schema.sql.includes("checktable")) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE sheet_template_new (
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
          FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`);
        db.exec("INSERT INTO sheet_template_new SELECT id, year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include FROM sheet_template");
        db.exec("DROP TABLE sheet_template");
        db.exec("ALTER TABLE sheet_template_new RENAME TO sheet_template");
        db.exec("CREATE INDEX IF NOT EXISTS idx_st_year ON sheet_template(year)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_st_parent ON sheet_template(parent_id)");
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}

db.pragma("foreign_keys = ON");

db.transaction(() => {
  // 검차 시트 템플릿 테이블 (4단계 계층: category → subcategory → group → item)
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_template (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
    parent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable') OR answer_type IS NULL),
    remarks TEXT DEFAULT '',
    FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_st_year ON sheet_template(year);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_st_parent ON sheet_template(parent_id);`);

  // 컬럼 마이그레이션
  const cols = db.prepare("PRAGMA table_info(sheet_template)").all();
  if (!cols.find(c => c.name === "unit")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN unit TEXT DEFAULT ''`);
  }
  if (!cols.find(c => c.name === "pdf_include")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN pdf_include INTEGER DEFAULT 1`);
  }

  // 검차 시트 답변 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_answer (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    value TEXT DEFAULT '',
    memo TEXT DEFAULT '',
    PRIMARY KEY (year, team_num, item_id),
    FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);

  // 검차 시트 큰 카테고리별 결과 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_category_result (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    result TEXT DEFAULT '' CHECK(result IN ('PASS', 'FAIL', '')),
    PRIMARY KEY (year, team_num, category_id),
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);

  // 검차 시트 큰 카테고리별 검차관 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_inspector (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    inspector TEXT DEFAULT '',
    PRIMARY KEY (year, team_num, category_id),
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
})();

setupProcessHandlers(db);

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "inspection");

const app = createApp({ express }, (req) => {
  if (req.path.startsWith("/api/sheet/template") && req.method !== "GET") return "admin";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "official";
  return "official"; // SPA
});

app.get("/api/logs", logger.queryHandler);

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
import { createSSEManager } from "../shared/sse.mjs";
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

// SSE 엔드포인트
app.get("/api/sheet/events", sseHandler());

/* ============================================
   API 라우트: 검차 시트
   ============================================ */

// GET /api/sheet/template - 연도별 템플릿 트리 반환
app.get("/api/sheet/template", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => {
    const rows = db.prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY sort_order").all(year);
    const map = {};
    for (const r of rows) map[r.id] = r;

    const tree = [];
    for (const r of rows) {
      if (r.level === "category") {
        tree.push({ ...r, subcategories: [] });
      }
    }
    for (const r of rows) {
      if (r.level === "subcategory" && map[r.parent_id]) {
        const cat = tree.find(c => c.id === r.parent_id);
        if (cat) cat.subcategories.push({ ...r, groups: [] });
      }
    }
    for (const r of rows) {
      if (r.level === "group" && map[r.parent_id]) {
        for (const cat of tree) {
          const sub = cat.subcategories.find(s => s.id === r.parent_id);
          if (sub) { sub.groups.push({ ...r, items: [] }); break; }
        }
      }
    }
    for (const r of rows) {
      if (r.level === "item" && map[r.parent_id]) {
        outer: for (const cat of tree) {
          for (const sub of cat.subcategories) {
            const grp = sub.groups.find(g => g.id === r.parent_id);
            if (grp) { grp.items.push(r); break outer; }
          }
        }
      }
    }
    return tree;
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/sheet/template - 노드 생성
app.post("/api/sheet/template", (req, res) => {
  const { year, level, parent_id, name, sort_order, answer_type, remarks, unit, pdf_include } = req.body;
  if (!year || !level || !name) return res.status(400).send("필수 필드가 누락되었습니다.");

  const result = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(year, level, parent_id || null, sort_order || 0, name, answer_type || null, remarks || "", unit || "", pdf_include ?? 1)
  );

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "template.create", { year, level }, name);
  res.json({ id: result.result.lastInsertRowid });
});

// PUT /api/sheet/template/:id - 노드 수정
app.put("/api/sheet/template/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, sort_order, answer_type, remarks, unit, pdf_include } = req.body;

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push("name = ?"); params.push(name); }
  if (sort_order !== undefined) { fields.push("sort_order = ?"); params.push(sort_order); }
  if (answer_type !== undefined) { fields.push("answer_type = ?"); params.push(answer_type || null); }
  if (remarks !== undefined) { fields.push("remarks = ?"); params.push(remarks); }
  if (unit !== undefined) { fields.push("unit = ?"); params.push(unit); }
  if (pdf_include !== undefined) { fields.push("pdf_include = ?"); params.push(pdf_include ? 1 : 0); }

  if (!fields.length) return res.status(400).send("수정할 필드가 없습니다.");
  params.push(id);

  const result = dbRun(() =>
    db.prepare(`UPDATE sheet_template SET ${fields.join(", ")} WHERE id = ?`).run(...params)
  );

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "template.update", { fields: fields.map(f => f.split(" = ")[0]) }, String(id));
  res.status(200).send();
});

// DELETE /api/sheet/template/:id - 노드 삭제 (CASCADE)
app.delete("/api/sheet/template/:id", (req, res) => {
  const id = Number(req.params.id);

  const result = dbRun(() => {
    return db.prepare("DELETE FROM sheet_template WHERE id = ?").run(id);
  });

  if (!result.success) return res.status(result.status).send(result.error);
  if (!result.result.changes) return res.status(404).send("노드를 찾을 수 없습니다.");
  logger.log(req, "template.delete", null, String(id));
  res.status(200).send();
});

// POST /api/sheet/template/reorder - 형제 노드 순서 변경
app.post("/api/sheet/template/reorder", (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).send("items 배열이 필요합니다.");

  const result = dbRun(() => {
    const stmt = db.prepare("UPDATE sheet_template SET sort_order = ? WHERE id = ?");
    db.transaction(() => {
      for (const item of items) {
        stmt.run(item.sort_order, item.id);
      }
    })();
  });

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "template.reorder", { count: items.length });
  res.status(200).send();
});

// POST /api/sheet/template/copy - 연도간 템플릿 복사
app.post("/api/sheet/template/copy", (req, res) => {
  const { from_year, to_year } = req.body;
  if (!from_year || !to_year) return res.status(400).send("from_year, to_year가 필요합니다.");

  const result = dbRun(() => {
    const existing = db.prepare("SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ?").get(to_year);
    if (existing.cnt > 0) throw { status: 400, message: "대상 연도에 이미 템플릿이 존재합니다." };

    const rows = db.prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY id").all(from_year);
    if (!rows.length) throw { status: 400, message: "원본 연도에 템플릿이 없습니다." };

    db.transaction(() => {
      const idMap = {};
      const stmt = db.prepare(
        "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const r of rows) {
        const newParent = r.parent_id ? idMap[r.parent_id] : null;
        const info = stmt.run(to_year, r.level, newParent, r.sort_order, r.name, r.answer_type, r.remarks, r.unit || "", r.pdf_include ?? 1);
        idMap[r.id] = info.lastInsertRowid;
      }
    })();
  });

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "template.copy", { from_year, to_year });
  res.status(201).send();
});

// POST /api/sheet/template/import - JSON 파일로 템플릿 가져오기
app.post("/api/sheet/template/import", (req, res) => {
  const { year, template } = req.body;
  if (!year || !Array.isArray(template)) return res.status(400).send("year, template 배열이 필요합니다.");

  const result = dbRun(() => {
    db.prepare("DELETE FROM sheet_template WHERE year = ? AND level = 'category'").run(year);

    const stmt = db.prepare(
      "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    db.transaction(() => {
      for (let ci = 0; ci < template.length; ci++) {
        const cat = template[ci];
        const catInfo = stmt.run(year, "category", null, ci, cat.name, null, cat.remarks || "", "", cat.pdf_include ?? 1);
        const catId = catInfo.lastInsertRowid;

        if (!Array.isArray(cat.subcategories)) continue;
        for (let si = 0; si < cat.subcategories.length; si++) {
          const sub = cat.subcategories[si];
          const subInfo = stmt.run(year, "subcategory", catId, si, sub.name, null, sub.remarks || "", "", 1);
          const subId = subInfo.lastInsertRowid;

          if (!Array.isArray(sub.groups)) continue;
          for (let gi = 0; gi < sub.groups.length; gi++) {
            const grp = sub.groups[gi];
            const grpInfo = stmt.run(year, "group", subId, gi, grp.name, null, grp.remarks || "", "", 1);
            const grpId = grpInfo.lastInsertRowid;

            if (!Array.isArray(grp.items)) continue;
            for (let ii = 0; ii < grp.items.length; ii++) {
              const item = grp.items[ii];
              stmt.run(year, "item", grpId, ii, item.name, item.answer_type || "passfail", item.remarks || "", item.unit || "", 1);
            }
          }
        }
      }
    })();
  });

  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "template.import", { year });
  res.status(201).send();
});

// GET /api/sheet/summary - 모든 팀의 카테고리별 요약
app.get("/api/sheet/summary", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => {
    const categories = db.prepare(
      "SELECT id, name FROM sheet_template WHERE year = ? AND level = 'category' ORDER BY sort_order"
    ).all(year);

    const inspectors = db.prepare(
      "SELECT team_num, category_id, inspector FROM sheet_inspector WHERE year = ?"
    ).all(year);

    const results = db.prepare(
      "SELECT team_num, category_id, result FROM sheet_category_result WHERE year = ?"
    ).all(year);

    const teams = {};
    for (const row of inspectors) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].inspectors[row.category_id] = row.inspector;
    }
    for (const row of results) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].results[row.category_id] = row.result;
    }

    return { categories, teams };
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/sheet/bulk-answers - 벌크 답변 조회 (특정 item_id들의 팀별 값)
app.get("/api/sheet/bulk-answers", (req, res) => {
  const year = Number(req.query.year);
  const itemIdsParam = req.query.item_ids;
  if (!year || !itemIdsParam) return res.status(400).send("year, item_ids 필수");

  const itemIds = itemIdsParam.split(",").map(Number).filter(n => !isNaN(n));
  if (!itemIds.length) return res.status(400).send("유효한 item_ids가 없습니다.");

  const result = dbRun(() => {
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT team_num, item_id, value FROM sheet_answer WHERE year = ? AND item_id IN (${placeholders})`
    ).all(year, ...itemIds);

    const teams = {};
    for (const row of rows) {
      if (!teams[row.team_num]) teams[row.team_num] = {};
      teams[row.team_num][row.item_id] = row.value;
    }
    return teams;
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/sheet/data/:year/:num - 팀의 모든 시트 데이터 반환
app.get("/api/sheet/data/:year/:num", (req, res) => {
  const year = Number(req.params.year);
  const num = Number(req.params.num);

  const result = dbRun(() => {
    const answers = db.prepare(
      "SELECT item_id, value, memo FROM sheet_answer WHERE year = ? AND team_num = ?"
    ).all(year, num);

    const categoryResults = db.prepare(
      "SELECT category_id, result FROM sheet_category_result WHERE year = ? AND team_num = ?"
    ).all(year, num);

    const inspectors = db.prepare(
      "SELECT category_id, inspector FROM sheet_inspector WHERE year = ? AND team_num = ?"
    ).all(year, num);

    const answersMap = {};
    for (const a of answers) answersMap[a.item_id] = { value: a.value, memo: a.memo };

    const resultsMap = {};
    for (const r of categoryResults) resultsMap[r.category_id] = r.result;

    const inspectorsMap = {};
    for (const i of inspectors) inspectorsMap[i.category_id] = i.inspector;

    return { answers: answersMap, results: resultsMap, inspectors: inspectorsMap };
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/sheet/answer - 답변 upsert
app.put("/api/sheet/answer", (req, res) => {
  const { year, team_num, item_id, value } = req.body;
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  const newValue = value ?? "";

  const result = dbRun(() => {
    const prev = db.prepare(
      "SELECT value FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?"
    ).get(year, team_num, item_id);

    db.prepare(
      "INSERT INTO sheet_answer (year, team_num, item_id, value) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, item_id) DO UPDATE SET value = excluded.value"
    ).run(year, team_num, item_id, newValue);

    return { changed: !prev || prev.value !== newValue };
  });

  if (!result.success) return res.status(result.status).send(result.error);

  if (result.result.changed) {
    logger.log(req, "answer.update", { year, item_id, value: newValue }, `#${team_num}`);
    broadcastEvent("answer", { year, team_num, item_id, value: newValue });
  }

  res.status(200).send();
});

// PUT /api/sheet/memo - 메모 upsert
app.put("/api/sheet/memo", (req, res) => {
  const { year, team_num, item_id, memo } = req.body;
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");

  const result = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_answer (year, team_num, item_id, memo) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, item_id) DO UPDATE SET memo = excluded.memo"
    ).run(year, team_num, item_id, memo ?? "")
  );

  if (!result.success) return res.status(result.status).send(result.error);

  logger.log(req, "memo.update", { year, item_id }, `#${team_num}`);
  broadcastEvent("memo", { year, team_num, item_id, memo: memo ?? "" });

  res.status(200).send();
});

// PUT /api/sheet/category-result - 카테고리 결과 upsert
app.put("/api/sheet/category-result", (req, res) => {
  const { year, team_num, category_id, result: catResult } = req.body;
  if (!year || team_num == null || !category_id) return res.status(400).send("필수 필드가 누락되었습니다.");

  const r = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_category_result (year, team_num, category_id, result) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET result = excluded.result"
    ).run(year, team_num, category_id, catResult ?? "")
  );

  if (!r.success) return res.status(r.status).send(r.error);

  logger.log(req, "category_result.update", { year, category_id, result: catResult }, `#${team_num}`);
  broadcastEvent("category-result", { year, team_num, category_id, result: catResult ?? "" });

  res.status(200).send();
});

// PUT /api/sheet/inspector - 검차관 upsert
app.put("/api/sheet/inspector", (req, res) => {
  const { year, team_num, category_id, inspector } = req.body;
  if (!year || team_num == null || !category_id) return res.status(400).send("필수 필드가 누락되었습니다.");

  const result = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_inspector (year, team_num, category_id, inspector) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET inspector = excluded.inspector"
    ).run(year, team_num, category_id, inspector ?? "")
  );

  if (!result.success) return res.status(result.status).send(result.error);

  logger.log(req, "inspector.update", { year, category_id, inspector }, `#${team_num}`);
  if (req.body.broadcast) {
    broadcastEvent("inspector", { year, team_num, category_id, inspector: inspector ?? "" });
  }

  res.status(200).send();
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9600);
