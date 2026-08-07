import http from "http";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir, requireInternalRequest } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { registerTeamLifecycleRoutes } from "../shared/team-lifecycle.mjs";
import { ensureTeamStatusTable, isTeamActive, registerTeamStatusRoute } from "../shared/team-status.mjs";
import { serviceUrl } from "../shared/services.mjs";
import { calculateEnergyScores } from "./lib/energy-score.mjs";

const PORT = 9600;

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

  // 수동 입력 점수 (보고서, 가점, 감점). 기존 energy 행은 호환성을 위해 보존만 한다.
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

  // 연도별 공개 성적표 활성화 여부
  db.exec(`CREATE TABLE IF NOT EXISTS score_publication (
    year INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
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
    fuel_consumed REAL,
    fuel_extra REAL,
    electric_net_energy REAL,
    energy_dsq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (year, team_num)
  )`);
  addColumn(db, "score_endurance", "fuel_consumed REAL");
  addColumn(db, "score_endurance", "fuel_extra REAL");
  addColumn(db, "score_endurance", "electric_net_energy REAL");
  addColumn(db, "score_endurance", "energy_dsq INTEGER NOT NULL DEFAULT 0");
})();
ensureTeamStatusTable(db);

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
  fuel_consumed: "UPDATE score_endurance SET fuel_consumed = ? WHERE year = ? AND team_num = ?",
  fuel_extra: "UPDATE score_endurance SET fuel_extra = ? WHERE year = ? AND team_num = ?",
  electric_net_energy: "UPDATE score_endurance SET electric_net_energy = ? WHERE year = ? AND team_num = ?",
  energy_dsq: "UPDATE score_endurance SET energy_dsq = ? WHERE year = ? AND team_num = ?",
};

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "score");

// inter-service 실패 로그 폭주 방지: action+year별 최소 60초 간격 throttle
const _warnThrottle = new Map();
function warnThrottled(action, detail, windowMs = 60000) {
  const t = Date.now();
  const key = `${action}|${detail?.year ?? ""}|${detail?.source ?? ""}`;
  const last = _warnThrottle.get(key) || 0;
  if (t - last < windowMs) return;
  _warnThrottle.set(key, t);
  logger.warn(null, action, detail);
}

const publishedYears = new Set(
  db.prepare("SELECT year FROM score_publication WHERE enabled = 1").all().map((row) => row.year),
);

function isScorePublished(year) {
  return publishedYears.has(Number(year));
}

function parseScoreYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2099 ? year : null;
}

// 공개 요청이 순차적으로 들어와도 매번 전체 업스트림 집계를 반복하지 않도록 짧게 캐시한다.
// SSE 변경 이벤트가 도착하면 TTL과 관계없이 즉시 무효화되어 공개 화면의 실시간성은 유지된다.
const PUBLIC_SCORE_CACHE_TTL_MS = 3000;
const publicScoreCache = new Map();
const publicScoreGenerations = new Map();
let publicScoreGlobalGeneration = 0;

function getPublicScoreGeneration(year) {
  return {
    global: publicScoreGlobalGeneration,
    year: publicScoreGenerations.get(year) || 0,
  };
}

function isPublicScoreGenerationCurrent(year, generation) {
  return generation.global === publicScoreGlobalGeneration
    && generation.year === (publicScoreGenerations.get(year) || 0);
}

function invalidatePublicScoreCache(year = null) {
  if (year == null) {
    publicScoreCache.clear();
    publicScoreGlobalGeneration++;
  } else {
    const numYear = Number(year);
    publicScoreCache.delete(numYear);
    publicScoreGenerations.set(numYear, (publicScoreGenerations.get(numYear) || 0) + 1);
  }
}

const app = createApp({ express, validateUser: options.validateUser }, (req) => {
  if (req.path === "/api/health") return null;
  if (/^\/api\/score\/public\/\d{4}(?:\/events)?$/.test(req.path)) return null;
  if (/^\/public\/\d{4}$/.test(req.path)) return null;
  // 공개 페이지가 인증 없이 부트스트랩될 수 있도록 Vite 정적 자산도 공개한다.
  if (req.path.startsWith("/assets/") || req.path === "/env-config.js") return null;
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = serviceUrl("entry");
const INSPECTION_SERVER = serviceUrl("inspection");
const TRAFFIC_SERVER = serviceUrl("traffic");

// 내부 서비스 호출 타임아웃 — 집계 시 기록 테이블이 커서 5초보다 여유 있게 둔다
const INTERNAL_FETCH_TIMEOUT_MS = 10000;

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
  // traffic의 연도별 엔드포인트는 기록이 없는 연도도 200/[]로 응답하므로,
  // 과거에 있던 전체 목록(/api/records + /visibility) 폴백 경로는 정상 운영에서
  // 도달 불가능한 죽은 코드였다. 실패는 로깅 후 그대로 던진다.
  let yearRes;
  try {
    yearRes = await fetch(`${TRAFFIC_SERVER}/api/records/year/${year}`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    logger.warn(null, "score.fetch_records", { error: e.message, year, endpoint: "year" });
    throw new Error("경기 목록을 가져올 수 없습니다.");
  }
  if (!yearRes.ok) {
    warnThrottled("score.fetch_records", { status: yearRes.status, year });
    throw new Error("경기 목록을 가져올 수 없습니다.");
  }
  const rows = await yearRes.json();
  return rows.map((row) => ({ tableName: row.name, records: row.records || [] }));
}

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastAdminEvent, handler: sseHandler } = createSSEManager();
const { broadcast: broadcastPublicEvent, handler: publicSseHandler } = createSSEManager(500);

// 관리자에게는 원본 이벤트를, 공개 페이지에는 데이터가 없는 refresh 신호만 보낸다.
// 공개 클라이언트가 관리자용 SSE 페이로드를 통해 숨긴 열의 값을 받지 않도록 스트림을 분리한다.
function broadcastEvent(event, data) {
  broadcastAdminEvent(event, data);
  const eventYear = parseScoreYear(data?.year);
  invalidatePublicScoreCache(eventYear);
  // 변경 전 스냅샷으로 시작한 집계를 이벤트 직후의 관리자 재조회가
  // 재사용하지 않게 한다. 기존 요청은 완료하되, 다음 요청은 새 집계를 시작한다.
  invalidateInflightScore(eventYear);
  broadcastPublicEvent("refresh", {}, (meta) => {
    if (!isScorePublished(meta.year)) return false;
    return eventYear == null || meta.year === eventYear;
  });
}

// SSE 엔드포인트
app.get("/api/score/events", sseHandler());

const handlePublicSSE = publicSseHandler(
  (req) => ({ year: Number(req.params.year) }),
  {
    meta: (req) => ({ year: Number(req.params.year) }),
    revalidate: (meta) => isScorePublished(meta.year) ? meta : null,
    // 공개 스트림이므로 단일 IP가 전체 연결 슬롯을 점유하지 못하게 제한한다.
    maxPerIp: 10,
  },
);

app.get("/api/score/public/:year/events", (req, res) => {
  const year = parseScoreYear(req.params.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
  handlePublicSSE(req, res);
});

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
      if (res.statusCode !== 200) {
        // 비200 응답(403 시크릿 불일치, 503 maxClients 등)은 연결 성공이 아니다.
        // backoff를 리셋하지 않아야 영구 실패가 3초 간격 무한 재시도로 상대 서비스를
        // 두드리지 않고, 로깅해야 설정 오류가 조용히 묻히지 않는다.
        warnThrottled("score.sse_subscribe_failed", { source: name, status: res.statusCode });
        res.resume();
        res.on("end", () => scheduleReconnect());
        return;
      }

      connected = true;
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

    req.setTimeout(60000, () => {
      // 유휴 타임아웃(keepalive 두절/half-open 소켓)에서 인자 없는 destroy()는 'error'를
      // emit하지 않고, 스트리밍 중이던 res도 'end' 대신 'aborted'/'close'로 끝나므로 여기서
      // 재연결을 직접 예약해야 한다. scheduleReconnect의 reconnecting 가드가 중복을 막는다.
      req.destroy();
      scheduleReconnect();
    });
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
  const subscribeEntrySSE = createSSESubscriber("Entry", ENTRY_SERVER, "/api/events", "entry", new Set(["entries"]));
  const subscribeInspectionSSE = createSSESubscriber("Inspection", INSPECTION_SERVER, "/api/sheet/events", "inspection", new Set(["category-result", "answer"]));
  // event-mode: 활성 종목이 바뀌면 computeScore의 집계 대상이 달라지므로 재전파해야 프론트가
  // 스코어를 다시 계산한다(재전파 누락 시 새로고침 전까지 stale).
  const subscribeTrafficSSE = createSSESubscriber("Traffic", TRAFFIC_SERVER, "/api/events", "traffic", new Set(["records", "record-visibility", "event-mode"]));
  subscribeEntrySSE();
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

// year -> { promise, generation }. 같은 연도 동시 집계 요청을 하나로 합쳐 업스트림 호출 증폭을 막는다.
const inflightScore = new Map();

function invalidateInflightScore(year = null) {
  if (year == null) inflightScore.clear();
  else inflightScore.delete(Number(year));
}

function getComputedScoreRequest(year) {
  let request = inflightScore.get(year);
  if (!request) {
    request = {
      generation: getPublicScoreGeneration(year),
      promise: null,
    };
    request.promise = computeScore(year).finally(() => {
      if (inflightScore.get(year) === request) inflightScore.delete(year);
    });
    inflightScore.set(year, request);
  }
  return request;
}

function getComputedScore(year) {
  return getComputedScoreRequest(year).promise;
}

function createPublicScorePayload(year, score) {
  const entries = {};
  for (const [num, entry] of Object.entries(score.entries || {})) {
    entries[num] = {
      univ: entry.univ || "",
      team: entry.team || "",
      type: entry.type || "",
    };
  }

  const events = (score.events || [])
    .filter((event) => event.type !== "내구")
    .map((event) => {
      const penalty = score.penalties?.[event.type] || {};
      const records = {};
      for (const [num, record] of Object.entries(event.records || {})) {
        let result = record?.result ?? null;
        if (result != null && result !== -1) {
          result += (record.cones || 0) * (penalty.cone_penalty || 0) * 1000;
          result += (record.oc || 0) * (penalty.oc_penalty || 0) * 1000;
        }
        records[num] = { result };
      }
      return { type: event.type, records };
    });

  return { year, entries, events };
}

async function getPublicScorePayload(year) {
  while (true) {
    const cached = publicScoreCache.get(year);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;

    const request = getComputedScoreRequest(year);
    const score = await request.promise;
    if (!isScorePublished(year)) return null;
    // 집계 중 변경 이벤트가 발생했다면 무효화 이전 스냅샷을 반환하거나 캐시하지 않는다.
    if (!isPublicScoreGenerationCurrent(year, request.generation)) continue;

    const payload = createPublicScorePayload(year, score);
    publicScoreCache.set(year, {
      payload,
      expiresAt: Date.now() + PUBLIC_SCORE_CACHE_TTL_MS,
    });
    return payload;
  }
}

// GET /api/score/publication?year=YYYY — 관리자용 공개 상태 조회
app.get("/api/score/publication", (req, res) => {
  const year = parseScoreYear(req.query.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  res.json({ year, enabled: isScorePublished(year) });
});

// PUT /api/score/publication — 관리자용 연도별 공개 상태 변경
app.put("/api/score/publication", (req, res) => {
  const year = parseScoreYear(req.body.year);
  const { enabled } = req.body;
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  if (typeof enabled !== "boolean") return res.status(400).send("enabled는 boolean이어야 합니다.");

  const result = dbRun(() => db.prepare(`
    INSERT INTO score_publication (year, enabled) VALUES (?, ?)
    ON CONFLICT(year) DO UPDATE SET enabled = excluded.enabled
  `).run(year, enabled ? 1 : 0));

  if (!result.success) {
    logger.warn(req, "score_publication.update", { error: result.error, year, enabled }, String(year));
    return res.status(result.status).send(result.error);
  }

  if (enabled) publishedYears.add(year);
  else publishedYears.delete(year);
  invalidatePublicScoreCache(year);

  const payload = { year, enabled };
  logger.log(req, "score_publication.update", payload, String(year));
  broadcastAdminEvent("publication", payload);
  // 비공개 전환도 이미 접속한 공개 페이지에 전달해야 하므로 공개 여부 필터를 적용하지 않는다.
  broadcastPublicEvent("publication", payload, (meta) => meta.year === year);
  res.json(payload);
});

// GET /api/score/public/:year — 공개용 최소 데이터. 공개 중인 연도만 인증 없이 조회 가능하다.
app.get("/api/score/public/:year", async (req, res) => {
  const year = parseScoreYear(req.params.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
  try {
    const payload = await getPublicScorePayload(year);
    // 집계 도중 공개가 꺼졌다면 응답 직전에 다시 차단한다.
    if (!isScorePublished(year)) return res.status(404).send("공개 중인 성적표가 아닙니다.");
    res.json(payload);
  } catch (e) {
    logger.warn(req, "score.public_aggregate", { error: e.message, year }, String(year));
    res.status(500).send("데이터 집계 오류가 발생했습니다.");
  }
});

// GET /api/score?year=YYYY — 메인 집계 엔드포인트
app.get("/api/score", async (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");
  try {
    res.json(await getComputedScore(year));
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
      signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!entryRes.ok) {
      warnThrottled("score.fetch_entries", { status: entryRes.status, year });
      throw new Error("엔트리 정보를 가져올 수 없습니다.");
    }
    const entries = await entryRes.json();
    // The local lifecycle snapshot is an additional fail-closed guard for a rolling deploy or
    // an upstream cache that briefly still contains a just-deactivated entry.
    for (const num of Object.keys(entries)) {
      if (!isTeamActive(db, year, Number(num))) delete entries[num];
    }

    // 2. Inspection 서비스에서 카테고리별 PASS/FAIL 요약 fetch
    const [inspectionRes, templateRes] = await Promise.all([
      fetch(`${INSPECTION_SERVER}/api/sheet/summary?year=${year}`, {
        headers: internalHeaders(), signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
      }),
      fetch(`${INSPECTION_SERVER}/api/sheet/template?year=${year}`, {
        headers: internalHeaders(), signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
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
            headers: internalHeaders(), signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
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
        headers: internalHeaders(), signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
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
        if (!entries[rec.num]) continue;
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
    const enduranceRows = db.prepare(`
      SELECT e.* FROM score_endurance e
      WHERE e.year = ? AND NOT EXISTS (
        SELECT 1 FROM team_status s
        WHERE s.year = e.year AND s.team_num = e.team_num AND s.active = 0
      )
    `).all(year).filter((row) => entries[row.team_num]);
    const endurancePen = penalties["내구"] || { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
    for (const row of enduranceRows) {
      if (row.status === "DNS") continue; // DNS → 기록 없음
      if (row.status === "DNF" || row.status === "DSQ") {
        enduranceRecords[row.team_num] = { result: -1, cones: 0, oc: 0, allRuns: [] };
        continue;
      }
      // 두 드라이버 기록이 있으면 완주 기록으로 본다. 교체 초과시간 빈칸은 0초다.
      if (row.driver1_time != null && row.driver2_time != null) {
        const startDelayMs = ((row.driver1_start_delay || 0) + (row.driver2_start_delay || 0)) * (endurancePen.start_delay || 0) * 1000;
        const manualPenaltyMs = ((row.driver1_penalty || 0) + (row.driver2_penalty || 0)) * 1000;
        const result = row.driver1_time + row.driver2_time + (row.driver_change_time || 0) + startDelayMs + manualPenaltyMs;
        const cones = (row.driver1_cones || 0) + (row.driver2_cones || 0);
        const oc = (row.driver1_oc || 0) + (row.driver2_oc || 0);
        enduranceRecords[row.team_num] = { result, cones, oc, allRuns: [] };
      }
      // 시간 필드 불완전 → 기록 없음 (skip)
    }
    events.push({ type: "내구", records: enduranceRecords });

    // 7. 수동 입력 점수 조회. 레거시 energy 행은 보존하되 자동계산 결과와 섞지 않는다.
    const manualRows = db.prepare(`
      SELECT m.team_num, m.score_type, m.value FROM score_manual m
      WHERE m.year = ? AND NOT EXISTS (
        SELECT 1 FROM team_status s
        WHERE s.year = m.year AND s.team_num = m.team_num AND s.active = 0
      )
    `).all(year).filter((row) => entries[row.team_num]);
    const manualScores = {};
    for (const row of manualRows) {
      if (row.score_type === "energy") continue;
      if (!manualScores[row.team_num]) manualScores[row.team_num] = {};
      manualScores[row.team_num][row.score_type] = row.value;
    }

    // 8. 점수 설정 조회
    const settingRows = db.prepare("SELECT event_type, setting_key, value FROM score_setting WHERE year = ?").all(year);
    const settings = {};
    for (const row of settingRows) {
      if (!settings[row.event_type]) settings[row.event_type] = {};
      settings[row.event_type][row.setting_key] = row.value;
    }

    const energy = calculateEnergyScores({
      rows: enduranceRows,
      entries,
      enduranceRecords,
      endurancePenalty: endurancePen,
      settings: settings["에너지"] || {},
    });

    return { entries, inspection, events, manualScores, penalties, settings, energy };
}

// PUT /api/score/manual — 수동 입력 점수 저장 (보고서, 가점, 감점)
app.put("/api/score/manual", (req, res) => {
  const { year, team_num, score_type, value } = req.body;
  if (!year || team_num == null || !score_type) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  const numTeamNum = Number(team_num);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!Number.isInteger(numTeamNum) || numTeamNum < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!isTeamActive(db, numYear, numTeamNum)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");

  const keyErr = validateKey(score_type, "score_type");
  if (keyErr) return res.status(400).send(keyErr);
  if (score_type === "energy") return res.status(400).send("에너지 점수는 내구 계측값으로 자동 계산됩니다.");

  const numValue = value === null || value === "" ? null : Number(value);
  if (numValue !== null && !Number.isFinite(numValue)) return res.status(400).send("유효하지 않은 값입니다.");
  if (score_type === "report" && numValue !== null) {
    if (numValue < 0) return res.status(400).send("보고서 점수는 음수일 수 없습니다.");
    const reportTotal = db.prepare("SELECT value FROM score_setting WHERE year = ? AND event_type = '보고서' AND setting_key = 'total'").get(numYear)?.value;
    if (Number.isFinite(reportTotal) && numValue > reportTotal) {
      return res.status(400).send(`보고서 점수는 총점 ${reportTotal}점을 초과할 수 없습니다.`);
    }
  }

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

  const rows = db.prepare(`
    SELECT e.* FROM score_endurance e
    WHERE e.year = ? AND NOT EXISTS (
      SELECT 1 FROM team_status s
      WHERE s.year = e.year AND s.team_num = e.team_num AND s.active = 0
    )
  `).all(year);
  const result = {};
  for (const row of rows) {
    const {
      year: _year,
      team_num,
      energy_type: _legacyEnergyType,
      energy_dsq_reason: _legacyEnergyDsqReason,
      ...data
    } = row;
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
  if (!isTeamActive(db, numYear, numTeamNum)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");

  const allowedFields = [
    "status", "driver1_time", "driver1_start_delay", "driver1_cones", "driver1_oc", "driver1_penalty",
    "driver_change_time", "driver2_time", "driver2_start_delay", "driver2_cones", "driver2_oc", "driver2_penalty",
    "fuel_consumed", "fuel_extra", "electric_net_energy", "energy_dsq",
  ];
  if (!allowedFields.includes(field)) {
    return res.status(400).send("허용되지 않는 필드입니다.");
  }

  const textFields = new Set(["status"]);
  const dbValue = value === null || value === "" ? null : (textFields.has(field) ? String(value).trim() : Number(value));
  if (field === "status" && dbValue !== null && !["DNS", "DNF", "DSQ"].includes(dbValue)) {
    return res.status(400).send("올바르지 않은 상태값입니다. (DNS, DNF, DSQ 또는 비움)");
  }
  if (!textFields.has(field) && dbValue !== null && !Number.isFinite(dbValue)) {
    return res.status(400).send("유효하지 않은 값입니다.");
  }
  if (field === "energy_dsq" && dbValue !== null && ![0, 1].includes(dbValue)) {
    return res.status(400).send("에너지 실격 값은 0 또는 1이어야 합니다.");
  }
  if (!textFields.has(field) && field !== "electric_net_energy" && dbValue !== null && dbValue < 0) {
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

registerTeamStatusRoute(app, {
  db, dbRun, logger, requireInternalRequest, broadcastEvent,
  onApplied: ({ year }) => {
    invalidatePublicScoreCache(year);
    invalidateInflightScore(year);
  },
});

registerTeamLifecycleRoutes(app, {
  db, dbRun, logger, requireInternalRequest, broadcastEvent,
  tables: ["score_manual", "score_endurance"],
  channels: ["manual-score", "endurance"],
  statusTable: "team_status",
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/public/:year", (req, res) => {
  const year = parseScoreYear(req.params.year);
  if (year == null || !isScorePublished(year)) {
    return res.status(404).send("공개 중인 성적표가 아닙니다.");
  }
  res.sendFile("index.html", { root: "./web/dist" });
});

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
  app.listen(PORT, () => console.log(`Score service running on port ${PORT}`));
}
