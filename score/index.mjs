import http from "http";
import express from "express";
import pinoHttp from "pino-http";
import Database from "better-sqlite3";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";

/* ============================================
   Database 초기화
   ============================================ */
ensureDataDir();

const db = new Database("./data/score.db");

db.transaction(() => {
  // 레거시 테이블 정리
  db.exec(`DROP TABLE IF EXISTS score_event`);

  // 스키마 마이그레이션: event_type 컬럼이 없는 구버전 테이블 재생성
  const cols = db.prepare("PRAGMA table_info(score_record)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === "event_type")) {
    db.exec(`DROP TABLE score_record`);
  }

  // 팀별/경기 종목별 선택된 기록
  db.exec(`CREATE TABLE IF NOT EXISTS score_record (
    year INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    team_num INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    record_rowid INTEGER NOT NULL,
    PRIMARY KEY (year, event_type, team_num)
  )`);
})();

setupProcessHandlers(db);

/* ============================================
   Express 앱 설정
   ============================================ */
const app = createApp("score.log", { express, pinoHttp }, (req) => {
  return "admin";
});

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = process.env.ENTRY_SERVER || "http://localhost:9100";
const INSPECTION_SERVER = process.env.INSPECTION_SERVER || "http://localhost:9600";
const TRAFFIC_SERVER = process.env.TRAFFIC_SERVER || "http://localhost:9200";

function internalHeaders() {
  const h = {};
  if (process.env.INTERNAL_SECRET) h["X-Internal-Service"] = process.env.INTERNAL_SECRET;
  return h;
}

/* ============================================
   헬퍼
   ============================================ */
const dbRun = createDbRun();

async function fetchYearRecords(year) {
  const tablesRes = await fetch(`${TRAFFIC_SERVER}/api/records`, { headers: internalHeaders() });
  if (!tablesRes.ok) throw new Error("경기 목록을 가져올 수 없습니다.");
  const allTables = await tablesRes.json();
  const yearTables = allTables.filter((t) => t.startsWith(`FSK ${year}`));

  return Promise.all(
    yearTables.map(async (tableName) => {
      try {
        const recordRes = await fetch(
          `${TRAFFIC_SERVER}/api/records/${encodeURIComponent(tableName)}`,
          { headers: internalHeaders() },
        );
        if (recordRes.ok) return { tableName, records: await recordRes.json() };
      } catch {}
      return { tableName, records: [] };
    })
  );
}

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
import { createSSEManager } from "../shared/sse.mjs";
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

// SSE 엔드포인트
app.get("/api/score/events", sseHandler());

// Inspection 서비스 SSE 구독 → Score 클라이언트에 재전송
function subscribeInspectionSSE() {
  const url = new URL(`${INSPECTION_SERVER}/api/sheet/events`);

  const options = { headers: internalHeaders() };
  const req = http.get(url, options, (res) => {
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n\n");
      buffer = messages.pop(); // 마지막 불완전한 메시지는 버퍼에 유지

      for (const msg of messages) {
        try {
          const eventMatch = msg.match(/^event:\s*(.+)$/m);
          const dataMatch = msg.match(/^data:\s*(.+)$/m);
          if (eventMatch && dataMatch) {
            broadcastEvent(`inspection:${eventMatch[1]}`, JSON.parse(dataMatch[1]));
          }
        } catch (e) {
          console.error("Inspection SSE message parse error:", e);
        }
      }
    });

    res.on("end", () => {
      // 연결 끊기면 재접속
      setTimeout(subscribeInspectionSSE, 3000);
    });
  });

  req.on("error", () => {
    setTimeout(subscribeInspectionSSE, 3000);
  });
}

subscribeInspectionSSE();

// Traffic 서비스 SSE 구독 → 기록 자동 선택
function subscribeTrafficSSE() {
  const url = new URL(`${TRAFFIC_SERVER}/api/events`);

  const options = { headers: internalHeaders() };
  const req = http.get(url, options, (res) => {
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n\n");
      buffer = messages.pop();

      for (const msg of messages) {
        try {
          const eventMatch = msg.match(/^event:\s*(.+)$/m);
          const dataMatch = msg.match(/^data:\s*(.+)$/m);
          if (eventMatch && dataMatch && eventMatch[1] === "records") {
            const data = JSON.parse(dataMatch[1]);
            if (data.record && (data.type === "add" || (data.type === "update" && data.field === "invalidated"))) {
              autoSelectBestRecord(data.name, data.record.num, data.record.eventType);
            }
          }
        } catch (e) {
          console.error("Traffic SSE message parse error:", e);
        }
      }
    });

    res.on("end", () => {
      setTimeout(subscribeTrafficSSE, 3000);
    });
  });

  req.on("error", () => {
    setTimeout(subscribeTrafficSSE, 3000);
  });
}

// 무효화되지 않은 기록 중 최적 기록 자동 선택
async function autoSelectBestRecord(tableName, teamNum, eventType) {
  // 테이블명에서 연도 추출
  const yearMatch = tableName.match(/^FSK (\d{4})/);
  if (!yearMatch) return;
  const year = Number(yearMatch[1]);

  try {
    // 해당 연도의 모든 테이블에서 이 팀/종목의 기록을 수집
    let allTableRecords;
    try {
      allTableRecords = await fetchYearRecords(year);
    } catch { return; }

    const runs = [];
    for (const { tableName: tbl, records } of allTableRecords) {
      for (const rec of records) {
        if (rec.type === eventType && rec.num === teamNum) {
          runs.push({
            table_name: tbl,
            rowid: rec.rowid,
            result: rec.result,
            invalidated: rec.invalidated || 0,
          });
        }
      }
    }

    // 무효화되지 않은 기록만 필터링
    const valid = runs.filter((r) => !r.invalidated);

    // 유효 기록이 없으면 선택 해제
    if (valid.length === 0) {
      db.prepare("DELETE FROM score_record WHERE year = ? AND event_type = ? AND team_num = ?").run(year, eventType, teamNum);
      broadcastEvent("record-auto", { year, event_type: eventType, team_num: teamNum, selected: null });
      return;
    }

    // DNF(-1)가 아닌 기록 중 가장 빠른 기록, 없으면 DNF
    const nonDnf = valid.filter((r) => r.result >= 0);
    const best = nonDnf.length > 0
      ? nonDnf.reduce((a, b) => (a.result <= b.result ? a : b))
      : valid[0];

    db.prepare(
      `INSERT INTO score_record (year, event_type, team_num, table_name, record_rowid)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(year, event_type, team_num)
       DO UPDATE SET table_name = excluded.table_name, record_rowid = excluded.record_rowid`,
    ).run(year, eventType, teamNum, best.table_name, best.rowid);

    broadcastEvent("record-auto", {
      year,
      event_type: eventType,
      team_num: teamNum,
      selected: { table_name: best.table_name, rowid: best.rowid, result: best.result },
    });
  } catch (e) { console.error("autoSelectBestRecord:", e); }
}

subscribeTrafficSSE();

/* ============================================
   헬퍼: 템플릿 트리에서 카테고리 이름 기반 item 탐색
   ============================================ */
function findItemsInCategory(tree, categoryName, itemNames) {
  const result = {};
  result._allNumberItems = [];
  result._categoryId = null;

  const cat = tree.find((c) => c.name === categoryName);
  if (!cat) return result;

  result._categoryId = cat.id;

  for (const sub of cat.subcategories || []) {
    for (const grp of sub.groups || []) {
      for (const item of grp.items || []) {
        if (itemNames.length > 0 && itemNames.includes(item.name)) {
          result[item.name] = item.id;
        }
        if (item.answer_type === "number") {
          result._allNumberItems.push({ id: item.id, name: item.name });
        }
      }
    }
  }

  return result;
}

/* ============================================
   API 라우트
   ============================================ */

// GET /api/score?year=YYYY — 메인 집계 엔드포인트
app.get("/api/score", async (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  try {
    // 1. Entry 서비스에서 엔트리 목록 fetch
    const entryRes = await fetch(`${ENTRY_SERVER}/api/entries?year=${year}`);
    if (!entryRes.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
    const entries = await entryRes.json();

    // 2. Inspection 서비스에서 카테고리별 PASS/FAIL 요약 fetch
    const [inspectionRes, templateRes] = await Promise.all([
      fetch(`${INSPECTION_SERVER}/api/sheet/summary?year=${year}`, { headers: internalHeaders() }),
      fetch(`${INSPECTION_SERVER}/api/sheet/template?year=${year}`, { headers: internalHeaders() }),
    ]);
    if (!inspectionRes.ok) throw new Error("검차 정보를 가져올 수 없습니다.");
    const inspection = await inspectionRes.json();

    // 2b. 템플릿 트리에서 코너웨이트 item ID 탐색
    let cornerWeight = null;

    if (templateRes.ok) {
      const tree = await templateRes.json();

      const cwItems = findItemsInCategory(tree, "코너웨이트", ["공차중량", "FL", "FR", "RL", "RR"]);

      // 코너웨이트: 5개 항목 모두 존재해야 유효
      if (cwItems["공차중량"] && cwItems["FL"] && cwItems["FR"] && cwItems["RL"] && cwItems["RR"]) {
        cornerWeight = {
          categoryId: cwItems._categoryId,
          items: { curb: cwItems["공차중량"], fl: cwItems["FL"], fr: cwItems["FR"], rl: cwItems["RL"], rr: cwItems["RR"] },
          teams: {},
        };
      }

      // 벌크 답변 fetch
      const allItemIds = [];
      if (cornerWeight) allItemIds.push(...Object.values(cornerWeight.items));

      if (allItemIds.length > 0) {
        try {
          const bulkRes = await fetch(`${INSPECTION_SERVER}/api/sheet/bulk-answers?year=${year}&item_ids=${allItemIds.join(",")}`, { headers: internalHeaders() });
          if (bulkRes.ok) {
            const bulkData = await bulkRes.json(); // { [team_num]: { [item_id]: value } }
            for (const [num, items] of Object.entries(bulkData)) {
              if (cornerWeight) {
                const cw = {};
                if (items[cornerWeight.items.curb] !== undefined) cw.curb = items[cornerWeight.items.curb];
                if (items[cornerWeight.items.fl] !== undefined) cw.fl = items[cornerWeight.items.fl];
                if (items[cornerWeight.items.fr] !== undefined) cw.fr = items[cornerWeight.items.fr];
                if (items[cornerWeight.items.rl] !== undefined) cw.rl = items[cornerWeight.items.rl];
                if (items[cornerWeight.items.rr] !== undefined) cw.rr = items[cornerWeight.items.rr];
                if (Object.keys(cw).length > 0) cornerWeight.teams[num] = cw;
              }
            }
          }
        } catch {}
      }
    }

    inspection.cornerWeight = cornerWeight;

    // 3. Traffic 서비스에서 해당 연도의 모든 경기 기록 fetch
    const allTableRecords = await fetchYearRecords(year);

    // 4. 모든 테이블의 기록을 합쳐서 레코드의 type 필드(경기 종목)별로 그룹핑
    const typeMap = new Map(); // 경기종목 → { num → [...runs] }

    for (const { tableName, records } of allTableRecords) {
      for (const rec of records) {
        const eventType = rec.type; // 경기 종목: 가속, 스키드패드, 짐카나 등
        if (!eventType) continue;

        if (!typeMap.has(eventType)) {
          typeMap.set(eventType, {});
        }
        const group = typeMap.get(eventType);
        const num = rec.num;
        if (!group[num]) group[num] = [];
        group[num].push({
          table_name: tableName,
          rowid: rec.rowid,
          result: rec.result,
          detail: rec.detail || null,
          invalidated: rec.invalidated || 0,
          scoreboard: rec.scoreboard ?? 1,
          time: rec.time,
        });
      }
    }

    // 5. 로컬 DB에서 팀별 선택된 기록 조회
    const selectedRecords = db
      .prepare(
        "SELECT event_type, team_num, table_name, record_rowid FROM score_record WHERE year = ?",
      )
      .all(year);

    const selectedMap = {};
    for (const sr of selectedRecords) {
      if (!selectedMap[sr.event_type]) selectedMap[sr.event_type] = {};
      selectedMap[sr.event_type][sr.team_num] = {
        table_name: sr.table_name,
        rowid: sr.record_rowid,
      };
    }

    // 6. 종목별로 선택된 기록 정보 첨부
    const events = [];
    for (const [eventType, teamRecords] of typeMap) {
      const records = {};
      for (const [num, runs] of Object.entries(teamRecords)) {
        const sel = selectedMap[eventType]?.[Number(num)];
        const selected = sel
          ? runs.find((r) => r.table_name === sel.table_name && r.rowid === sel.rowid) || null
          : null;
        records[num] = {
          selected: selected
            ? {
                table_name: selected.table_name,
                rowid: selected.rowid,
                result: selected.result,
                detail: selected.detail,
              }
            : null,
          all: runs,
        };
      }
      events.push({ type: eventType, records });
    }

    res.json({ entries, inspection, events });
  } catch (e) {
    res.status(500).send(`데이터 집계 오류: ${e.message || e}`);
  }
});

// GET /api/score/records?year=YYYY&event_type=TYPE&team_num=NUM — 팀별 종목 기록 조회
app.get("/api/score/records", async (req, res) => {
  const year = Number(req.query.year);
  const eventType = req.query.event_type;
  const teamNum = Number(req.query.team_num);
  if (!year || !eventType || !teamNum) {
    return res.status(400).send("year, event_type, team_num 필수");
  }

  try {
    const allTableRecords = await fetchYearRecords(year);

    const runs = [];
    for (const { tableName, records } of allTableRecords) {
      for (const rec of records) {
        if (rec.type === eventType && rec.num === teamNum) {
          runs.push({
            table_name: tableName,
            rowid: rec.rowid,
            result: rec.result,
            detail: rec.detail || null,
            invalidated: rec.invalidated || 0,
            scoreboard: rec.scoreboard ?? 1,
            time: rec.time,
          });
        }
      }
    }

    // 기록 오름차순 정렬 (DNF=-1은 맨 뒤)
    runs.sort((a, b) => {
      if (a.result === -1 && b.result !== -1) return 1;
      if (a.result !== -1 && b.result === -1) return -1;
      return a.result - b.result;
    });

    const sel = db
      .prepare("SELECT table_name, record_rowid FROM score_record WHERE year = ? AND event_type = ? AND team_num = ?")
      .get(year, eventType, teamNum);

    const selected = sel ? runs.find((r) => r.table_name === sel.table_name && r.rowid === sel.record_rowid) || null : null;

    res.json({
      selected: selected ? { table_name: selected.table_name, rowid: selected.rowid, result: selected.result, detail: selected.detail } : null,
      all: runs,
    });
  } catch (e) {
    res.status(500).send(`기록 조회 오류: ${e.message || e}`);
  }
});

// PUT /api/score/record — 팀별 경기 종목 기록 선택
app.put("/api/score/record", (req, res) => {
  const { year, event_type, team_num, table_name, record_rowid, result: recResult, detail } = req.body;
  if (!year || !event_type || team_num == null || !table_name || !record_rowid) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }

  const result = dbRun(() =>
    db
      .prepare(
        `INSERT INTO score_record (year, event_type, team_num, table_name, record_rowid)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(year, event_type, team_num)
         DO UPDATE SET table_name = excluded.table_name, record_rowid = excluded.record_rowid`,
      )
      .run(year, event_type, team_num, table_name, record_rowid),
  );

  if (!result.success) return res.status(result.status).send(result.error);

  broadcastEvent("record-update", {
    year, event_type, team_num,
    selected: { table_name, rowid: record_rowid, result: recResult ?? null, detail: detail ?? null },
  });

  res.status(200).send();
});

// DELETE /api/score/record — 팀별 경기 종목 기록 선택 해제
app.delete("/api/score/record", (req, res) => {
  const { year, event_type, team_num } = req.body;
  if (!year || !event_type || team_num == null) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }

  const result = dbRun(() =>
    db
      .prepare("DELETE FROM score_record WHERE year = ? AND event_type = ? AND team_num = ?")
      .run(year, event_type, team_num),
  );

  if (!result.success) return res.status(result.status).send(result.error);

  broadcastEvent("record-update", { year, event_type, team_num, selected: null });

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
app.listen(9700);
