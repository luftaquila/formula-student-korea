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
const app = createApp("score.log", { express, pinoHttp });

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = process.env.ENTRY_SERVER || "http://localhost:9100";
const INSPECTION_SERVER = process.env.INSPECTION_SERVER || "http://localhost:9600";
const TRAFFIC_SERVER = process.env.TRAFFIC_SERVER || "http://localhost:9200";

/* ============================================
   헬퍼
   ============================================ */
const dbRun = createDbRun();

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

  const req = http.get(url, (res) => {
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n\n");
      buffer = messages.pop(); // 마지막 불완전한 메시지는 버퍼에 유지

      for (const msg of messages) {
        const eventMatch = msg.match(/^event:\s*(.+)$/m);
        const dataMatch = msg.match(/^data:\s*(.+)$/m);
        if (eventMatch && dataMatch) {
          broadcastEvent(`inspection:${eventMatch[1]}`, JSON.parse(dataMatch[1]));
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

  const req = http.get(url, (res) => {
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n\n");
      buffer = messages.pop();

      for (const msg of messages) {
        const eventMatch = msg.match(/^event:\s*(.+)$/m);
        const dataMatch = msg.match(/^data:\s*(.+)$/m);
        if (eventMatch && dataMatch && eventMatch[1] === "records") {
          const data = JSON.parse(dataMatch[1]);
          if (data.record && (data.type === "add" || (data.type === "update" && data.field === "invalidated"))) {
            autoSelectBestRecord(data.name, data.record.num, data.record.eventType);
          }
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
    const tablesRes = await fetch(`${TRAFFIC_SERVER}/api/records`);
    if (!tablesRes.ok) return;
    const allTables = await tablesRes.json();
    const yearTables = allTables.filter((t) => t.startsWith(`FSK ${year}`));

    const runs = [];
    for (const tbl of yearTables) {
      try {
        const recordRes = await fetch(`${TRAFFIC_SERVER}/api/records/${encodeURIComponent(tbl)}`);
        if (!recordRes.ok) continue;
        const records = await recordRes.json();
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
      } catch {}
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
  } catch {}
}

subscribeTrafficSSE();

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
    const inspectionRes = await fetch(`${INSPECTION_SERVER}/api/sheet/summary?year=${year}`);
    if (!inspectionRes.ok) throw new Error("검차 정보를 가져올 수 없습니다.");
    const inspection = await inspectionRes.json();

    // 3. Traffic 서비스에서 모든 경기 테이블 목록 fetch
    const tablesRes = await fetch(`${TRAFFIC_SERVER}/api/records`);
    if (!tablesRes.ok) throw new Error("경기 목록을 가져올 수 없습니다.");
    const allTables = await tablesRes.json();

    // 해당 연도 테이블만 필터링
    const yearPrefix = `FSK ${year}`;
    const yearTables = allTables.filter((t) => t.startsWith(yearPrefix));

    // 4. 모든 테이블의 기록을 합쳐서 레코드의 type 필드(경기 종목)별로 그룹핑
    const typeMap = new Map(); // 경기종목 → { num → [...runs] }

    for (const tableName of yearTables) {
      let records = [];
      try {
        const recordRes = await fetch(
          `${TRAFFIC_SERVER}/api/records/${encodeURIComponent(tableName)}`,
        );
        if (recordRes.ok) {
          records = await recordRes.json();
        }
      } catch {
        // Traffic 서비스 연결 실패 시 빈 기록
      }

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
    const tablesRes = await fetch(`${TRAFFIC_SERVER}/api/records`);
    if (!tablesRes.ok) throw new Error("경기 목록을 가져올 수 없습니다.");
    const allTables = await tablesRes.json();
    const yearTables = allTables.filter((t) => t.startsWith(`FSK ${year}`));

    const runs = [];
    for (const tableName of yearTables) {
      try {
        const recordRes = await fetch(`${TRAFFIC_SERVER}/api/records/${encodeURIComponent(tableName)}`);
        if (!recordRes.ok) continue;
        const records = await recordRes.json();
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
      } catch {}
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
