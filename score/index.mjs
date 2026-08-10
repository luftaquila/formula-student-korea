import express from "express";
import Database from "better-sqlite3";
import { addColumn, runMigrationOnce } from "../shared/db-setup.mjs";
import { createServiceSkeleton, addSpaFallback, runIfDirect } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { createSSESubscriber } from "../shared/sse-client.mjs";
import { createTeamStateClient } from "../shared/team-state-client.mjs";
import { serviceUrl } from "../shared/services.mjs";
import { calculateEnergyScores } from "./lib/energy-score.mjs";

export function createScoreApp(options = {}) {

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "score", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (/^\/api\/score\/public\/\d{4}(?:\/events)?$/.test(req.path)) return null;
    if (/^\/public\/\d{4}$/.test(req.path)) return null;
    // 공개 페이지가 인증 없이 부트스트랩될 수 있도록 Vite 정적 자산도 공개한다.
    if (req.path.startsWith("/assets/") || req.path === "/env-config.js") return null;
    return "admin";
  },
});

db.transaction(() => {
  // 레거시 테이블 정리
  const legacyTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('score_event', 'score_record')").all();
  if (legacyTables.length > 0) {
    console.log(`[score] Dropping legacy tables: ${legacyTables.map(t => t.name).join(", ")}`);
    db.exec(`DROP TABLE IF EXISTS score_event`);
    db.exec(`DROP TABLE IF EXISTS score_record`);
  }

  // 수동 입력 점수 (보고서, 가점, 감점). 기존 energy 행은 호환성을 위해 보존만 한다.
  // team_id = entry의 불변 팀 id(리넘버·개명에도 불변). 레거시 행은 NULL로 남았다가
  // team-state 백필이 (year, team_num) 매칭으로 채운다. team_num은 표시·레거시 키.
  db.exec(`CREATE TABLE IF NOT EXISTS score_manual (
    year INTEGER NOT NULL,
    team_id INTEGER,
    team_num INTEGER NOT NULL,
    score_type TEXT NOT NULL,
    value REAL
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
    team_id INTEGER,
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
    energy_dsq INTEGER NOT NULL DEFAULT 0
  )`);
  addColumn(db, "score_endurance", "fuel_consumed REAL");
  addColumn(db, "score_endurance", "fuel_extra REAL");
  addColumn(db, "score_endurance", "electric_net_energy REAL");
  addColumn(db, "score_endurance", "energy_dsq INTEGER NOT NULL DEFAULT 0");

  // 기존 배포 DB의 (year, team_num[, score_type]) PK 테이블을 team_id 병기 스키마로 재구축.
  // PK 대신 rowid 테이블 + 이중 UNIQUE 인덱스(id 키 = 새 조인 키, num 키 = 기존 불변식
  // "연도·번호당 1행" 유지 + 백필 전 안전망).
  runMigrationOnce(db, "score.team_id_rekey.v1", () => {
    for (const [table, keyCols] of [["score_manual", "score_type"], ["score_endurance", null]]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes("team_id")) continue; // 신규 DB — 위 CREATE가 이미 새 스키마
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      if (table === "score_manual") {
        db.exec(`CREATE TABLE score_manual (
          year INTEGER NOT NULL, team_id INTEGER, team_num INTEGER NOT NULL,
          score_type TEXT NOT NULL, value REAL
        )`);
        db.exec(`INSERT INTO score_manual (year, team_num, score_type, value)
                 SELECT year, team_num, score_type, value FROM score_manual_old`);
      } else {
        const dataCols = cols.filter((c) => !["year", "team_num", "energy_type", "energy_dsq_reason"].includes(c));
        db.exec(`CREATE TABLE score_endurance (
          year INTEGER NOT NULL, team_id INTEGER, team_num INTEGER NOT NULL,
          status TEXT, driver1_time INTEGER, driver1_start_delay INTEGER DEFAULT 0,
          driver1_cones INTEGER DEFAULT 0, driver1_oc INTEGER DEFAULT 0, driver1_penalty REAL DEFAULT 0,
          driver_change_time INTEGER, driver2_time INTEGER, driver2_start_delay INTEGER DEFAULT 0,
          driver2_cones INTEGER DEFAULT 0, driver2_oc INTEGER DEFAULT 0, driver2_penalty REAL DEFAULT 0,
          fuel_consumed REAL, fuel_extra REAL, electric_net_energy REAL,
          energy_dsq INTEGER NOT NULL DEFAULT 0
        )`);
        const copyCols = dataCols.filter((c) => c !== "team_id").join(", ");
        db.exec(`INSERT INTO score_endurance (year, team_num, ${copyCols})
                 SELECT year, team_num, ${copyCols} FROM score_endurance_old`);
      }
      db.exec(`DROP TABLE ${table}_old`);
    }
  }, { transaction: false });
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sm_id_key ON score_manual(year, team_id, score_type)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sm_num_key ON score_manual(year, team_num, score_type)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_se_id_key ON score_endurance(year, team_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_se_num_key ON score_endurance(year, team_num)");
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
  fuel_consumed: "UPDATE score_endurance SET fuel_consumed = ? WHERE year = ? AND team_num = ?",
  fuel_extra: "UPDATE score_endurance SET fuel_extra = ? WHERE year = ? AND team_num = ?",
  electric_net_energy: "UPDATE score_endurance SET electric_net_energy = ? WHERE year = ? AND team_num = ?",
  energy_dsq: "UPDATE score_endurance SET energy_dsq = ? WHERE year = ? AND team_num = ?",
};

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

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = serviceUrl("entry");
const INSPECTION_SERVER = serviceUrl("inspection");
const TRAFFIC_SERVER = serviceUrl("traffic");

/* ============================================
   Entry team-state (미러 대체 캐시 + 수렴형 강제)
   ============================================ */
const teamState = createTeamStateClient({ db, logger, service: "score" });

// 백필: 레거시 (year, team_num) 행에 team_id를 채운다 (연도별 1회, 첫 유효 스냅샷)
teamState.registerBackfill((year, state) => {
  const updManual = db.prepare("UPDATE score_manual SET team_id = ? WHERE year = ? AND team_num = ? AND team_id IS NULL");
  const updEndur = db.prepare("UPDATE score_endurance SET team_id = ? WHERE year = ? AND team_num = ? AND team_id IS NULL");
  for (const team of state.teams.values()) {
    updManual.run(team.id, year, team.num);
    updEndur.run(team.id, year, team.num);
  }
  const orphans = db.prepare("SELECT COUNT(*) AS c FROM score_manual WHERE year = ? AND team_id IS NULL").get(year).c
    + db.prepare("SELECT COUNT(*) AS c FROM score_endurance WHERE year = ? AND team_id IS NULL").get(year).c;
  if (orphans > 0) {
    // entry가 모르는 팀의 행 — 삭제하지 않고 로그만 (기존 reconcile 철학)
    logger.warn(null, "score.team_id_backfill", { year, unmatched_rows: orphans });
  }
});

// 수렴형 강제: 스냅샷 version이 바뀔 때마다 멱등 실행
teamState.registerEnforcement((year, state) => {
  // ① tombstone cascade — 삭제·교체된 팀의 점수 삭제 (기존 DELETE /api/internal/team 시맨틱)
  const delManual = db.prepare("DELETE FROM score_manual WHERE year = ? AND team_id = ?");
  const delEndur = db.prepare("DELETE FROM score_endurance WHERE year = ? AND team_id = ?");
  let deletedRows = 0;
  const deletedIds = [];
  for (const t of state.tombstones) {
    const n = delManual.run(year, t.id).changes + delEndur.run(year, t.id).changes;
    if (n > 0) {
      deletedRows += n;
      deletedIds.push(t.id);
    }
  }
  if (deletedRows > 0) {
    logger.log(null, "team.delete", { year, team_ids: deletedIds, rows: deletedRows });
  }

  // ② 비활성 정리 훅 없음 — score는 조회 필터로만 제외한다 (기존과 동일)

  // ③ 비정규화 갱신: 리넘버된 팀의 team_num을 id 기준으로 최신화. 두 팀이 번호를 맞바꾼
  // 경우 단일 패스는 num UNIQUE에 걸리므로, 바뀐 행을 먼저 임시 번호(-team_id, 음수라
  // 실번호와 충돌 불가)로 옮긴 뒤 최종 번호를 쓴다 — 전부 한 트랜잭션 안의 로컬 처리.
  const tmpNumManual = db.prepare("UPDATE score_manual SET team_num = -team_id WHERE year = ? AND team_id = ? AND team_num != ?");
  const tmpNumEndur = db.prepare("UPDATE score_endurance SET team_num = -team_id WHERE year = ? AND team_id = ? AND team_num != ?");
  const finNumManual = db.prepare("UPDATE score_manual SET team_num = ? WHERE year = ? AND team_id = ? AND team_num = -team_id");
  const finNumEndur = db.prepare("UPDATE score_endurance SET team_num = ? WHERE year = ? AND team_id = ? AND team_num = -team_id");
  let renumbered = 0;
  for (const team of state.teams.values()) {
    renumbered += tmpNumManual.run(year, team.id, team.num).changes
      + tmpNumEndur.run(year, team.id, team.num).changes;
  }
  for (const team of state.teams.values()) {
    finNumManual.run(team.num, year, team.id);
    finNumEndur.run(team.num, year, team.id);
  }
  if (renumbered > 0) logger.log(null, "team.renumber", { year, rows: renumbered });

  // ④ 모르는 팀(스냅샷·tombstone 어디에도 없는 team_id) — 로그만, 삭제 금지
  const knownIds = new Set([...state.teams.keys(), ...state.tombstones.map((t) => t.id)]);
  const localIds = db.prepare(`
    SELECT DISTINCT team_id FROM (
      SELECT team_id FROM score_manual WHERE year = ? AND team_id IS NOT NULL
      UNION SELECT team_id FROM score_endurance WHERE year = ? AND team_id IS NOT NULL
    )`).all(year, year).map((r) => r.team_id);
  const unknown = localIds.filter((id) => !knownIds.has(id));
  if (unknown.length > 0 && teamState.throttled(`unknown:${year}`)) {
    logger.warn(null, "score.team_state_unknown", { year, team_ids: unknown });
  }

  // 상태가 바뀌었으므로 집계 캐시 무효화 (기존 team-active onApplied와 동일)
  invalidatePublicScoreCache(year);
  invalidateInflightScore(year);

  if (deletedRows > 0 || renumbered > 0) {
    return () => {
      broadcastEvent("manual-score", { year });
      broadcastEvent("endurance", { year });
    };
  }
});

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

// 업스트림 SSE를 score 클라이언트로 재전파하는 구독 래퍼 (공유 sse-client 사용).
// allowedEvents: score 프론트가 실제로 구독하는 이벤트만 재전파해 traffic의 wireless
// 텔레메트리/이벤트 firehose(초당 다수)가 핸들러도 없는 모든 score 클라로 흘러가
// 대역폭·CPU를 낭비하는 것을 막는다.
function createUpstreamRelay(name, serverUrl, eventPath, prefix, allowedEvents) {
  return createSSESubscriber({
    name,
    url: `${serverUrl}${eventPath}`,
    headers: internalHeaders,
    allowedEvents,
    onEvent: (evName, data) => broadcastEvent(`${prefix}:${evName}`, data),
    // 재연결 = 끊긴 동안의 이벤트 유실 가능 → 클라에 전체 재조회 신호
    onReconnect: () => broadcastEvent("refresh", { source: name }),
    onWarn: (kind, detail) => {
      if (kind === "subscribe_failed") warnThrottled("score.sse_subscribe_failed", detail);
      else logger.warn(null, `score.sse_${kind}`, detail);
    },
  });
}

if (!options.skipSSESubscriptions) {
  // score 프론트(useSSE.js)가 실제 구독하는 이벤트만 재전파.
  createUpstreamRelay("Entry", ENTRY_SERVER, "/api/events", "entry", new Set(["entries"])).start();
  createUpstreamRelay("Inspection", INSPECTION_SERVER, "/api/sheet/events", "inspection", new Set(["category-result", "answer"])).start();
  // event-mode: 활성 종목이 바뀌면 computeScore의 집계 대상이 달라지므로 재전파해야 프론트가
  // 스코어를 다시 계산한다(재전파 누락 시 새로고침 전까지 stale).
  createUpstreamRelay("Traffic", TRAFFIC_SERVER, "/api/events", "traffic", new Set(["records", "record-visibility", "event-mode"])).start();
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
    res.status(e.status || 500).send(e.status === 503 ? e.message : "데이터 집계 오류가 발생했습니다.");
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
    res.status(e.status || 500).send(e.status === 503 ? e.message : "데이터 집계 오류가 발생했습니다.");
  }
});

// 연도별 성적 집계(엔트리·검차·경기기록·수동점수·설정). 실패 시 throw(라우트가 e.status 처리).
async function computeScore(year) {
    // 1. 엔트리 목록 = team-state 캐시 (serve-stale이라 entry 장애 중에도 집계가 계속된다).
    // 콜드 스타트에서 아직 한 번도 스냅샷을 못 받았을 때만 503.
    const state = await teamState.getState(year);
    if (!state.loaded) {
      const err = new Error("엔트리 정보를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.");
      err.status = 503;
      throw err;
    }
    const entries = {};
    for (const t of state.teams.values()) {
      if (t.active) entries[t.num] = { id: t.id, univ: t.univ, team: t.team, type: t.type, active: true };
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

    // 6b. 내구 기록: score_endurance 테이블에서 조회 (활성·존재 필터는 entries가 담당)
    const enduranceRecords = {};
    const enduranceRows = db.prepare("SELECT e.* FROM score_endurance e WHERE e.year = ?")
      .all(year).filter((row) => entries[row.team_num]);
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
    const manualRows = db.prepare("SELECT m.team_num, m.score_type, m.value FROM score_manual m WHERE m.year = ?")
      .all(year).filter((row) => entries[row.team_num]);
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
app.put("/api/score/manual", async (req, res) => {
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
  if (score_type === "energy") return res.status(400).send("에너지 점수는 내구 계측값으로 자동 계산됩니다.");

  // 쓰기는 team_id로 키잉하므로 num→id 해석이 필요하다. num은 가변 식별자라 TTL 내
  // 캐시로 해석하면 같은 번호의 팀 교체 직후 tombstone된 옛 id에 점수가 달렸다가 다음
  // 수렴에서 삭제되는 창이 생긴다 — 정체성을 부여하는 쓰기는 강제 refresh로 최신
  // 스냅샷을 받아 해석한다(관리자 액션이라 핫패스 아님; entry 미가용이면 serve-stale
  // 폴백 = 기존 push 시스템의 전달 지연 창과 동일한 잔여 위험). 스냅샷이 아예 없으면
  // 503, 스냅샷에 없는 번호는 404, 비활성 팀은 409.
  const writeState = await teamState.refresh(numYear);
  if (!writeState.loaded) return res.status(503).send("엔트리 정보를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.");
  const writeTeam = writeState.byNum.get(numTeamNum);
  if (!writeTeam) return res.status(404).send("존재하지 않는 엔트리 번호입니다.");
  if (!writeTeam.active) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
  const teamId = writeTeam.id;

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
    db.transaction(() => {
      // 백필을 못 받은 레거시 행(같은 번호, team_id NULL)이 있으면 현재 팀으로 귀속시킨다 —
      // 예전 num-키 체계에서 번호가 곧 소유였던 것과 같은 시맨틱.
      db.prepare("UPDATE score_manual SET team_id = ? WHERE year = ? AND team_num = ? AND team_id IS NULL")
        .run(teamId, numYear, numTeamNum);
      db.prepare(
        `INSERT INTO score_manual (year, team_id, team_num, score_type, value)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(year, team_id, score_type)
         DO UPDATE SET value = excluded.value, team_num = excluded.team_num`,
      ).run(numYear, teamId, numTeamNum, score_type, numValue);
    })(),
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
app.get("/api/score/endurance", async (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  // 비활성 팀 제외 — 캐시의 비활성 번호 목록을 파라미터로 바인딩 (미로드 시 '[]' = 전원 노출,
  // 기존 absent-row-means-active와 동일한 fail-open)
  const state = await teamState.getState(year);
  const rows = db.prepare(`
    SELECT e.* FROM score_endurance e
    WHERE e.year = ? AND e.team_num NOT IN (SELECT value FROM json_each(?))
  `).all(year, state.inactiveNumsJson);
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
app.put("/api/score/endurance", async (req, res) => {
  const { year, team_num, field, value } = req.body;
  if (!year || team_num == null || !field) {
    return res.status(400).send("필수 필드가 누락되었습니다.");
  }
  const numYear = Number(year);
  const numTeamNum = Number(team_num);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!Number.isInteger(numTeamNum) || numTeamNum < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");

  // manual과 동일: 정체성 부여 쓰기는 강제 refresh로 최신 num→id 매핑을 확보한다
  const enduranceState = await teamState.refresh(numYear);
  if (!enduranceState.loaded) return res.status(503).send("엔트리 정보를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.");
  const enduranceTeam = enduranceState.byNum.get(numTeamNum);
  if (!enduranceTeam) return res.status(404).send("존재하지 않는 엔트리 번호입니다.");
  if (!enduranceTeam.active) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
  const enduranceTeamId = enduranceTeam.id;

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
      // 레거시 행 귀속 후 id 키 upsert (manual과 동일한 시맨틱)
      db.prepare("UPDATE score_endurance SET team_id = ? WHERE year = ? AND team_num = ? AND team_id IS NULL")
        .run(enduranceTeamId, numYear, numTeamNum);
      db.prepare("INSERT OR IGNORE INTO score_endurance (year, team_id, team_num) VALUES (?, ?, ?)")
        .run(numYear, enduranceTeamId, numTeamNum);
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

// entry 팀 상태 동기화 기동 (SSE 구독 + 부팅 fetch). 테스트는 skipSSESubscriptions로
// 네트워크 구독을 끄고 teamState.refresh(year)를 직접 호출한다.
if (!options.skipSSESubscriptions) teamState.start();

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

addSpaFallback(app);

return { app, db, teamState };
}

runIfDirect(import.meta, "score", createScoreApp);
