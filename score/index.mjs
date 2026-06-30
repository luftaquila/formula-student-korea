import http from "http";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir, requireInternalRequest } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";

export function createScoreApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/score.db");

db.transaction(() => {
  // 레거시 테이블 정리
  const legacyTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('score_event', 'score_record')").all();
  if (legacyTables.length > 0) {
    console.log(`[score] Dropping legacy tables: ${legacyTables.map(t => t.name).join(", ")}`);
    db.exec(`DROP TABLE IF EXISTS score_event`);
    db.exec(`DROP TABLE IF EXISTS score_record`);
  }

  // 수동 입력 점수 (보고서, 에너지 등)
  db.exec(`CREATE TABLE IF NOT EXISTS score_manual (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    score_type TEXT NOT NULL,
    value REAL,
    PRIMARY KEY (year, team_num, score_type)
  )`);

  // 경기 종목별 페널티 설정 (콘터치/코스이탈/출발지연 초)
  db.exec(`CREATE TABLE IF NOT EXISTS score_penalty (
    year INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    cone_penalty REAL NOT NULL DEFAULT 0,
    oc_penalty REAL NOT NULL DEFAULT 0,
    start_delay REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (year, event_type)
  )`);

  // 마이그레이션: start_delay 컬럼 추가
  addColumn(db, "score_penalty", "start_delay REAL NOT NULL DEFAULT 0");

  // 경기 종목별 점수 설정 (총점/완주점수/컷오프)
  db.exec(`CREATE TABLE IF NOT EXISTS score_setting (
    year INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    value REAL,
    PRIMARY KEY (year, event_type, setting_key)
  )`);

  // 내구 기록 입력
  db.exec(`CREATE TABLE IF NOT EXISTS score_endurance (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    status TEXT,
    driver1_time INTEGER,
    driver1_start_delay INTEGER DEFAULT 0,
    driver1_cones INTEGER DEFAULT 0,
    driver1_oc INTEGER DEFAULT 0,
    driver1_penalty REAL DEFAULT 0,
    driver_change_time INTEGER,
    driver2_time INTEGER,
    driver2_start_delay INTEGER DEFAULT 0,
    driver2_cones INTEGER DEFAULT 0,
    driver2_oc INTEGER DEFAULT 0,
    driver2_penalty REAL DEFAULT 0,
    PRIMARY KEY (year, team_num)
  )`);
})();

const ENDURANCE_SQL = {
  status: "UPDATE score_endurance SET status = ? WHERE year = ? AND team_num = ?",
  driver1_time: "UPDATE score_endurance SET driver1_time = ? WHERE year = ? AND team_num = ?",
  driver1_start_delay: "UPDATE score_endurance SET driver1_start_delay = ? WHERE year = ? AND team_num = ?",
  driver1_cones: "UPDATE score_endurance SET driver1_cones = ? WHERE year = ? AND team_num = ?",
  driver1_oc: "UPDATE score_endurance SET driver1_oc = ? WHERE year = ? AND team_num = ?",
  driver1_penalty: "UPDATE score_endurance SET driver1_penalty = ? WHERE year = ? AND team_num = ?",
  driver_change_time: "UPDATE score_endurance SET driver_change_time = ? WHERE year = ? AND team_num = ?",
  driver2_time: "UPDATE score_endurance SET driver2_time = ? WHERE year = ? AND team_num = ?",
  driver2_start_delay: "UPDATE score_endurance SET driver2_start_delay = ? WHERE year = ? AND team_num = ?",
  driver2_cones: "UPDATE score_endurance SET driver2_cones = ? WHERE year = ? AND team_num = ?",
  driver2_oc: "UPDATE score_endurance SET driver2_oc = ? WHERE year = ? AND team_num = ?",
  driver2_penalty: "UPDATE score_endurance SET driver2_penalty = ? WHERE year = ? AND team_num = ?",
};

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "score");

// inter-service 실패 로그 폭주 방지: action+year별 최소 60초 간격 throttle
const _warnThrottle = new Map();
function warnThrottled(action, detail, windowMs = 60000) {
  const t = Date.now();
  const key = `${action}|${detail?.year ?? ""}`;
  const last = _warnThrottle.get(key) || 0;
  if (t - last < windowMs) return;
  _warnThrottle.set(key, t);
  logger.warn(null, action, detail);
}

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

function renumberTeamRows(table, prevNum, newNum, year) {
  const existing = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE year = ? AND team_num = ?`).get(year, prevNum).count;
  if (existing === 0) return 0;
  db.prepare(`DELETE FROM ${table} WHERE year = ? AND team_num = ?`).run(year, newNum);
  return db.prepare(`UPDATE ${table} SET team_num = ? WHERE year = ? AND team_num = ?`).run(newNum, year, prevNum).changes;
}

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = process.env.ENTRY_SERVER || "http://localhost:9200";
const INSPECTION_SERVER = process.env.INSPECTION_SERVER || "http://localhost:9400";
const TRAFFIC_SERVER = process.env.TRAFFIC_SERVER || "http://localhost:9500";

function internalHeaders() {
  const h = {};
  if (process.env.INTERNAL_SECRET) h["X-Internal-Service"] = process.env.INTERNAL_SECRET;
  return h;
}

/* ============================================
   헬퍼
   ============================================ */
const dbRun = createDbRun();

function validateKey(key, label) {
  if (!key || typeof key !== "string" || key.trim() === "") return `${label}이(가) 비어있습니다.`;
  if (key.length > 50) return `${label}이(가) 너무 깁니다.`;
  return null;
}

async function fetchYearRecords(year) {
  try {
    const yearRes = await fetch(`${TRAFFIC_SERVER}/api/records/year/${year}`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (yearRes.ok) {
      const rows = await yearRes.json();
      return rows.map((row) => ({ tableName: row.name, records: row.records || [] }));
    }
    if (yearRes.status !== 404) {
      warnThrottled("score.fetch_records", { status: yearRes.status, year });
    }
  } catch (e) {
    logger.warn(null, "score.fetch_records", { error: e.message, year, endpoint: "year" });
  }

  const [tablesRes, visRes] = await Promise.all([
    fetch(`${TRAFFIC_SERVER}/api/records`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`${TRAFFIC_SERVER}/api/records/visibility`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null),
  ]);
  if (!tablesRes.ok) {
    warnThrottled("score.fetch_records", { status: tablesRes.status, year });
    throw new Error("경기 목록을 가져올 수 없습니다.");
  }
  const allTables = await tablesRes.json();
  const visibility = visRes?.ok ? await visRes.json() : {};
  const yearTables = allTables.filter((t) => t.startsWith(`FSK ${year}`) && visibility[t] !== false);

  return Promise.all(
    yearTables.map(async (tableName) => {
      try {
        const recordRes = await fetch(
          `${TRAFFIC_SERVER}/api/records/${encodeURIComponent(tableName)}`,
          { headers: internalHeaders(), signal: AbortSignal.timeout(10000) },
        );
        if (recordRes.ok) return { tableName, records: await recordRes.json() };
      } catch (e) {
        logger.warn(null, "score.fetch_records", { error: e.message, tableName });
      }
      return { tableName, records: [] };
    })
  );
}

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

// SSE 엔드포인트
app.get("/api/score/events", sseHandler());

// SSE 메시지 파싱용 정규식 (모듈 스코프에 캐싱)
const EVENT_RE = /^event:\s*(.+)$/m;
const DATA_RE = /^data:\s*(.*)$/gm;

// SSE 구독 팩토리 (중복 연결 방지 + exponential backoff)
// allowedEvents: 재전파할 이벤트 이름 화이트리스트(Set). null=전부. score 프론트가 실제로
// 구독하는 이벤트만 재전파해 traffic의 wireless 텔레메트리/이벤트 firehose(초당 다수)가
// 핸들러도 없는 모든 score 클라로 흘러가 대역폭·CPU를 낭비하는 것을 막는다.
function createSSESubscriber(name, serverUrl, eventPath, prefix, allowedEvents = null) {
  let reconnecting = false;
  let connected = false;
  let backoff = 3000;
  const MAX_BACKOFF = 30000;

  function subscribe() {
    if (reconnecting) return;

    const url = new URL(`${serverUrl}${eventPath}`);
    const options = { headers: internalHeaders() };
    const req = http.get(url, options, (res) => {
      connected = res.statusCode === 200;
      const wasReconnect = backoff > 3000;
      backoff = 3000; // 연결 성공 시 backoff 리셋
      if (wasReconnect) {
        broadcastEvent("refresh", { source: name });
      }
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) {
          logger.warn(null, "score.sse_overflow", { source: name });
          buffer = "";
          return;
        }
        const messages = buffer.split("\n\n");
        buffer = messages.pop();

        for (const msg of messages) {
          try {
            const eventMatch = msg.match(EVENT_RE);
            if (!eventMatch) continue;
            const evName = eventMatch[1].trim();
            // 화이트리스트 밖 이벤트는 파싱·재전파하지 않는다(firehose 차단).
            if (allowedEvents && !allowedEvents.has(evName)) continue;
            const dataLines = msg.match(DATA_RE);
            if (!dataLines) continue;
            const jsonStr = dataLines.map(l => l.replace(/^data:\s*/, "")).join("\n");
            broadcastEvent(`${prefix}:${evName}`, JSON.parse(jsonStr));
          } catch (e) {
            logger.warn(null, "score.sse_parse_error", { source: name, error: e.message });
          }
        }
      });

      res.on("end", () => {
        scheduleReconnect();
      });
    });

    req.setTimeout(60000, () => { req.destroy(); });
    req.on("error", () => {
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (connected) {
      logger.warn(null, "score.sse_disconnect", { source: name });
      connected = false;
    }
    if (reconnecting) return;
    reconnecting = true;
    setTimeout(() => {
      reconnecting = false;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      subscribe();
    }, backoff);
  }

  return subscribe;
}

if (!options.skipSSESubscriptions) {
  // score 프론트(useSSE.js)가 실제 구독하는 이벤트만 재전파.
  const subscribeInspectionSSE = createSSESubscriber("Inspection", INSPECTION_SERVER, "/api/sheet/events", "inspection", new Set(["category-result", "answer"]));
  const subscribeTrafficSSE = createSSESubscriber("Traffic", TRAFFIC_SERVER, "/api/events", "traffic", new Set(["records", "record-visibility"]));
  subscribeInspectionSSE();
  subscribeTrafficSSE();
}

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

// year -> Promise. 같은 연도 동시 집계 요청을 하나로 합쳐 업스트림 호출 증폭을 막는다.
const inflightScore = new Map();

// GET /api/score?year=YYYY — 메인 집계 엔드포인트
app.get("/api/score", async (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");
  // in-flight 합치기: 기록 추가 시 다수 score 클라가 동시에 refetch해도 1회만 집계.
  let p = inflightScore.get(year);
  if (!p) {
    p = computeScore(year).finally(() => inflightScore.delete(year));
    inflightScore.set(year, p);
  }
  try {
    res.json(await p);
  } catch (e) {
    logger.warn(req, "score.aggregate", { error: e.message, year }, String(year));
    res.status(500).send("데이터 집계 오류가 발생했습니다.");
  }
});

// 연도별 성적 집계(엔트리·검차·경기기록·수동점수·설정). 실패 시 throw(라우트가 500 처리).
async function computeScore(year) {
    // 1. Entry 서비스에서 엔트리 목록 fetch
    const entryRes = await fetch(`${ENTRY_SERVER}/api/entries?year=${year}`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!entryRes.ok) {
      warnThrottled("score.fetch_entries", { status: entryRes.status, year });
      throw new Error("엔트리 정보를 가져올 수 없습니다.");
    }
    const entries = await entryRes.json();

    // 2. Inspection 서비스에서 카테고리별 PASS/FAIL 요약 fetch
    const [inspectionRes, templateRes] = await Promise.all([
      fetch(`${INSPECTION_SERVER}/api/sheet/summary?year=${year}`, {
        headers: internalHeaders(), signal: AbortSignal.timeout(10000),
      }),
      fetch(`${INSPECTION_SERVER}/api/sheet/template?year=${year}`, {
        headers: internalHeaders(), signal: AbortSignal.timeout(10000),
      }),
    ]);
    if (!inspectionRes.ok) {
      warnThrottled("score.fetch_inspection", { status: inspectionRes.status, year });
      throw new Error("검차 정보를 가져올 수 없습니다.");
    }
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
          const bulkRes = await fetch(`${INSPECTION_SERVER}/api/sheet/bulk-answers?year=${year}&item_ids=${allItemIds.join(",")}`, {
            headers: internalHeaders(), signal: AbortSignal.timeout(10000),
          });
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
          } else {
            warnThrottled("score.fetch_bulk_answers", { status: bulkRes.status, year });
          }
        } catch (e) {
          logger.warn(null, "score.fetch_bulk_answers", { error: e.message, year });
        }
      }
    } else {
      warnThrottled("score.fetch_template", { status: templateRes.status, year });
    }

    inspection.cornerWeight = cornerWeight;

    // 3. Traffic 서비스에서 활성화된 경기 모드 및 해당 연도의 모든 경기 기록 fetch
    let enabledModes = null;
    try {
      const modesRes = await fetch(`${TRAFFIC_SERVER}/api/event-modes`, {
        headers: internalHeaders(), signal: AbortSignal.timeout(10000),
      });
      if (modesRes.ok) {
        const modes = await modesRes.json();
        enabledModes = new Set(modes.filter((m) => m.enabled).map((m) => m.event_type));
      } else {
        warnThrottled("score.fetch_event_modes", { status: modesRes.status, year });
      }
    } catch (e) {
      logger.warn(null, "score.fetch_event_modes", { error: e.message });
    }

    const allTableRecords = await fetchYearRecords(year);

    // 4. 모든 테이블의 기록을 합쳐서 레코드의 type 필드(경기 종목)별로 그룹핑
    const typeMap = new Map(); // 경기종목 → { num → [...runs] }

    for (const { tableName, records } of allTableRecords) {
      for (const rec of records) {
        const eventType = rec.type; // 경기 종목: 가속, 스키드패드, 오토크로스 등
        if (!eventType) continue;

        if (!typeMap.has(eventType)) {
          typeMap.set(eventType, {});
        }
        const group = typeMap.get(eventType);
        const num = rec.num;
        if (!group[num]) group[num] = [];
        group[num].push({
          time: rec.time,
          result: rec.result,
          cones: rec.cones || 0,
          oc: rec.oc || 0,
          invalidated: rec.invalidated || 0,
        });
      }
    }

    // 5. 페널티 설정 조회 (최고 기록 산출에 필요)
    const penaltyRows = db.prepare("SELECT event_type, cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = ?").all(year);
    const penalties = {};
    for (const row of penaltyRows) {
      penalties[row.event_type] = { cone_penalty: row.cone_penalty, oc_penalty: row.oc_penalty, start_delay: row.start_delay };
    }

    // 6. 활성화된 경기 모드별로 최고 기록 산출 (내구는 항상 포함, score_endurance에서 별도 처리)
    const events = [];
    const eventTypes = enabledModes ? [...enabledModes] : [...typeMap.keys()];
    // 내구는 traffic에서 제외하고 score_endurance에서 별도 처리
    const nonEnduranceTypes = eventTypes.filter((t) => t !== "내구");
    for (const eventType of nonEnduranceTypes) {
      const teamRecords = typeMap.get(eventType) || {};
      const pen = penalties[eventType] || { cone_penalty: 0, oc_penalty: 0 };
      const records = {};
      for (const [num, runs] of Object.entries(teamRecords)) {
        const allRuns = runs.map((r) => ({ time: r.time, result: r.result, cones: r.cones, oc: r.oc, invalidated: r.invalidated }));
        const valid = runs.filter((r) => !r.invalidated);
        if (!valid.length) {
          records[num] = { result: null, cones: 0, oc: 0, allRuns };
          continue;
        }
        const finished = valid.filter((r) => r.result >= 0);
        if (finished.length) {
          // 페널티 반영 시간 기준으로 최고 기록 선택
          const best = finished.reduce((a, b) => {
            const aAdj = a.result + a.cones * pen.cone_penalty * 1000 + a.oc * pen.oc_penalty * 1000;
            const bAdj = b.result + b.cones * pen.cone_penalty * 1000 + b.oc * pen.oc_penalty * 1000;
            return aAdj <= bAdj ? a : b;
          });
          records[num] = { result: best.result, cones: best.cones, oc: best.oc, allRuns };
        } else {
          records[num] = { result: -1, cones: 0, oc: 0, allRuns };
        }
      }
      events.push({ type: eventType, records });
    }

    // 6b. 내구 기록: score_endurance 테이블에서 조회
    const enduranceRecords = {};
    const enduranceRows = db.prepare("SELECT * FROM score_endurance WHERE year = ?").all(year);
    const endurancePen = penalties["내구"] || { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
    for (const row of enduranceRows) {
      if (row.status === "DNS") continue; // DNS → 기록 없음
      if (row.status === "DNF" || row.status === "DSQ") {
        enduranceRecords[row.team_num] = { result: -1, cones: 0, oc: 0, allRuns: [] };
        continue;
      }
      // 정상: 세 시간 필드 모두 입력된 경우만
      if (row.driver1_time != null && row.driver2_time != null && row.driver_change_time != null) {
        const startDelayMs = ((row.driver1_start_delay || 0) + (row.driver2_start_delay || 0)) * (endurancePen.start_delay || 0) * 1000;
        const manualPenaltyMs = ((row.driver1_penalty || 0) + (row.driver2_penalty || 0)) * 1000;
        const result = row.driver1_time + row.driver2_time + row.driver_change_time + startDelayMs + manualPenaltyMs;
        const cones = (row.driver1_cones || 0) + (row.driver2_cones || 0);
        const oc = (row.driver1_oc || 0) + (row.driver2_oc || 0);
        enduranceRecords[row.team_num] = { result, cones, oc, allRuns: [] };
      }
      // 시간 필드 불완전 → 기록 없음 (skip)
    }
    events.push({ type: "내구", records: enduranceRecords });

    // 7. 수동 입력 점수 (보고서, 에너지) 조회
    const manualRows = db.prepare("SELECT team_num, score_type, value FROM score_manual WHERE year = ?").all(year);
    const manualScores = {};
    for (const row of manualRows) {
      if (!manualScores[row.team_num]) manualScores[row.team_num] = {};
      manualScores[row.team_num][row.score_type] = row.value;
    }

    // 9. 점수 설정 조회
    const settingRows = db.prepare("SELECT event_type, setting_key, value FROM score_setting WHERE year = ?").all(year);
    const settings = {};
    for (const row of settingRows) {
      if (!settings[row.event_type]) settings[row.event_type] = {};
      settings[row.event_type][row.setting_key] = row.value;
    }

    return { entries, inspection, events, manualScores, penalties, settings };
}

// PUT /api/score/manual — 수동 입력 점수 저장 (보고서, 에너지)
app.put("/api/score/manual", (req, res) => {
  const { year, team_num, score_type, value } = req.body;
  if (!year || team_num == null || !score_type) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  const numTeamNum = Number(team_num);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!Number.isInteger(numTeamNum) || numTeamNum < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");

  const keyErr = validateKey(score_type, "score_type");
  if (keyErr) return res.status(400).send(keyErr);

  const numValue = value === null || value === "" ? null : Number(value);
  if (numValue !== null && !Number.isFinite(numValue)) return res.status(400).send("유효하지 않은 값입니다.");

  const result = dbRun(() =>
    db
      .prepare(
        `INSERT INTO score_manual (year, team_num, score_type, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year, team_num, score_type)
         DO UPDATE SET value = excluded.value`,
      )
      .run(numYear, numTeamNum, score_type, numValue),
  );

  if (!result.success) {
    logger.warn(req, "manual_score.update", { error: result.error, year: numYear, score_type }, `#${numTeamNum}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "manual_score.update", { year: numYear, score_type, value: numValue }, `#${numTeamNum}`);
  broadcastEvent("manual-score", { year: numYear, team_num: numTeamNum, score_type, value: numValue });

  res.status(200).send();
});

// PUT /api/score/penalty — 경기 종목별 페널티 설정 저장
app.put("/api/score/penalty", (req, res) => {
  const { year, event_type, cone_penalty, oc_penalty, start_delay } = req.body;
  if (!year || !event_type) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  const keyErr = validateKey(event_type, "event_type");
  if (keyErr) return res.status(400).send(keyErr);

  const cone = cone_penalty == null ? 0 : Number(cone_penalty);
  const oc = oc_penalty == null ? 0 : Number(oc_penalty);
  const delay = start_delay == null ? 0 : Number(start_delay);

  if (!Number.isFinite(cone) || !Number.isFinite(oc) || !Number.isFinite(delay)) return res.status(400).send("유효하지 않은 값입니다.");
  if (cone < 0 || oc < 0 || delay < 0) return res.status(400).send("페널티 값은 음수일 수 없습니다.");

  const result = dbRun(() =>
    db
      .prepare(
        `INSERT INTO score_penalty (year, event_type, cone_penalty, oc_penalty, start_delay)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(year, event_type)
         DO UPDATE SET cone_penalty = excluded.cone_penalty, oc_penalty = excluded.oc_penalty, start_delay = excluded.start_delay`,
      )
      .run(numYear, event_type, cone, oc, delay),
  );

  if (!result.success) {
    logger.warn(req, "penalty.update", { error: result.error, year: numYear }, event_type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "penalty.update", { year: numYear, cone: cone, oc: oc, delay }, event_type);
  broadcastEvent("penalty", { year: numYear, event_type, cone_penalty: cone, oc_penalty: oc, start_delay: delay });

  res.status(200).send();
});

// PUT /api/score/setting — 경기 종목별 점수 설정 저장
app.put("/api/score/setting", (req, res) => {
  const { year, event_type, setting_key, value } = req.body;
  if (!year || !event_type || !setting_key) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  const etErr = validateKey(event_type, "event_type");
  if (etErr) return res.status(400).send(etErr);
  const skErr = validateKey(setting_key, "setting_key");
  if (skErr) return res.status(400).send(skErr);

  const numValue = value == null ? null : Number(value);

  if (numValue !== null && !Number.isFinite(numValue)) return res.status(400).send("유효하지 않은 값입니다.");
  if (numValue !== null && numValue < 0) return res.status(400).send("설정 값은 음수일 수 없습니다.");

  const result = dbRun(() =>
    db
      .prepare(
        `INSERT INTO score_setting (year, event_type, setting_key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year, event_type, setting_key)
         DO UPDATE SET value = excluded.value`,
      )
      .run(numYear, event_type, setting_key, numValue),
  );

  if (!result.success) {
    logger.warn(req, "setting.update", { error: result.error, year: numYear, key: setting_key }, event_type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "setting.update", { year: numYear, key: setting_key, value: numValue }, event_type);
  broadcastEvent("setting", { year: numYear, event_type, setting_key, value: numValue });

  res.status(200).send();
});

// GET /api/score/endurance?year=YYYY — 내구 기록 조회
app.get("/api/score/endurance", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const rows = db.prepare("SELECT * FROM score_endurance WHERE year = ?").all(year);
  const result = {};
  for (const row of rows) {
    const { year: _, team_num, ...data } = row;
    result[team_num] = data;
  }
  res.json(result);
});

// PUT /api/score/endurance — 내구 기록 단일 필드 저장
app.put("/api/score/endurance", (req, res) => {
  const { year, team_num, field, value } = req.body;
  if (!year || team_num == null || !field) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  const numTeamNum = Number(team_num);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!Number.isInteger(numTeamNum) || numTeamNum < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");

  const allowedFields = [
    "status", "driver1_time", "driver1_start_delay", "driver1_cones", "driver1_oc", "driver1_penalty",
    "driver_change_time", "driver2_time", "driver2_start_delay", "driver2_cones", "driver2_oc", "driver2_penalty",
  ];
  if (!allowedFields.includes(field)) {
    return res.status(400).send("허용되지 않는 필드입니다.");
  }

  const dbValue = value === null || value === "" ? null : (field === "status" ? value : Number(value));
  if (field === "status" && dbValue !== null && !["DNS", "DNF", "DSQ"].includes(dbValue)) {
    return res.status(400).send("올바르지 않은 상태값입니다. (DNS, DNF, DSQ 또는 비움)");
  }
  if (field !== "status" && dbValue !== null && !Number.isFinite(dbValue)) {
    return res.status(400).send("유효하지 않은 값입니다.");
  }
  if (field !== "status" && dbValue !== null && dbValue < 0) {
    return res.status(400).send("값은 음수일 수 없습니다.");
  }

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO score_endurance (year, team_num) VALUES (?, ?)").run(numYear, numTeamNum);
      db.prepare(ENDURANCE_SQL[field]).run(dbValue, numYear, numTeamNum);
    })();
  });

  if (!result.success) {
    logger.warn(req, "endurance.update", { error: result.error, year: numYear, field }, `#${numTeamNum}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "endurance.update", { year: numYear, field, value: dbValue }, `#${numTeamNum}`);
  broadcastEvent("endurance", { year: numYear, team_num: numTeamNum, field, value: dbValue });

  res.status(200).send();
});

/* ============================================
   Internal API: 엔트리 라이프사이클 연동
   ============================================ */

app.delete("/api/internal/team/:num", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const num = Number(req.params.num);
  const year = Number(req.query.year);
  if (!Number.isInteger(num) || num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!Number.isInteger(year)) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM score_manual WHERE year = ? AND team_num = ?").run(year, num);
      db.prepare("DELETE FROM score_endurance WHERE year = ? AND team_num = ?").run(year, num);
    })();
  });

  if (!result.success) {
    logger.warn(req, "team.cascade_delete", { error: result.error, year }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "team.cascade_delete", { year }, `#${num}`);
  broadcastEvent("manual-score", { year, team_num: num, deleted: true });
  broadcastEvent("endurance", { year, team_num: num, deleted: true });
  res.status(200).send();
});

app.patch("/api/internal/team-num", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const prevNum = Number(req.body.prevNum);
  const newNum = Number(req.body.newNum);
  const year = Number(req.body.year);
  if (!Number.isInteger(prevNum) || prevNum < 1 || !Number.isInteger(newNum) || newNum < 1 || !Number.isInteger(year)) {
    return res.status(400).send("올바르지 않은 요청입니다.");
  }
  // self-renumber는 helper가 목적지(=자기 번호) 행을 먼저 지운 뒤 갱신하므로 데이터 손실. 조기 반환.
  if (prevNum === newNum) return res.status(200).send();

  const result = dbRun(() => {
    db.transaction(() => {
      renumberTeamRows("score_manual", prevNum, newNum, year);
      renumberTeamRows("score_endurance", prevNum, newNum, year);
    })();
  });

  if (!result.success) {
    logger.warn(req, "team_num.update", { error: result.error, year, prevNum, newNum });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "team_num.update", { year, prevNum, newNum });
  broadcastEvent("manual-score", { year, prevNum, team_num: newNum, renumbered: true });
  broadcastEvent("endurance", { year, prevNum, team_num: newNum, renumbered: true });
  res.status(200).send();
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createScoreApp();
  setupProcessHandlers(db);
  app.listen(9600);
}
