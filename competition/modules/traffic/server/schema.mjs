import {
  setupRowCapRetention,
  runMigrationOnce,
  normalizeTimestampColumn,
} from "../../../../shared/server/db-setup.mjs";
import { EVENT_TYPES } from "../../../../shared/common/constants.js";

export function initializeSchema({ db, CONTROLLER_MAX_ROWS, RETAIN_EVENTS }) {
  // 동적 기록 테이블과 구분되는 예약 테이블 이름. 동적 테이블을 열거하는 모든
  // 쿼리에서 제외해야 한다(아래 reservedSql). 폐지된 controller도 기존 DB에 남을 수 있다.
  const RESERVED_TABLES = [
    "controller",
    "event_mode",
    "record_visibility",
    "record",
    "logs",
    "wireless_event",
    "wireless_mapping",
    "wireless_telemetry",
    "wireless_light",
    "wireless_session",
  ];

  const reservedSql = RESERVED_TABLES.map((n) => `'${n}'`).join(", ");

  // 기존 백업·복원 스키마 계약을 유지한다. 원본 통신 로그의 수집 API는 폐지되었다.
  db.exec(`CREATE TABLE IF NOT EXISTS controller (
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL
);`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_controller_timestamp ON controller(timestamp)");

  setupRowCapRetention(db, "controller", CONTROLLER_MAX_ROWS, { keyColumn: "rowid" });

  db.exec(`CREATE TABLE IF NOT EXISTS event_mode (
  event_type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);`);

  db.exec(`CREATE TABLE IF NOT EXISTS record_visibility (
  name TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 1
);`);

  function createRecordTable(table = "record", { teamId = false } = {}) {
    db.exec(`CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    legacy_rowid INTEGER NOT NULL,
    time TEXT NOT NULL,
    num INTEGER NOT NULL,
    univ TEXT NOT NULL,
    team TEXT NOT NULL,
    type TEXT NOT NULL,
    result INTEGER,
    status TEXT CHECK(status IS NULL OR status IN ('DNS', 'DNF', 'DSQ')),
    detail TEXT,
    cones INTEGER DEFAULT 0,
    oc INTEGER DEFAULT 0,
    scoreboard INTEGER DEFAULT 1${teamId ? ",\n    team_id INTEGER" : ""},
    CHECK(result IS NULL OR (typeof(result) = 'integer' AND result >= 0)),
    CHECK(status IS NOT NULL OR result IS NOT NULL)
  );`);
  }

  const recordTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record'")
    .get();

  if (!recordTable) {
    createRecordTable();
  } else {
    const info = db.prepare("PRAGMA table_info(record)").all();
    const columns = new Set(info.map((column) => column.name));
    // status가 없거나 옛 invalidated/source result NOT NULL 제약이 남은 DB를 한 번에 최종
    // 스키마로 재구성한다. 예상 밖 결과값은 CHECK에 기대어 부분 게시하지 않고 transaction 전체를 중단한다.
    const resultColumn = info.find((column) => column.name === "result");
    if (
      !columns.has("status") ||
      columns.has("invalidated") ||
      resultColumn?.notnull ||
      /result > 0/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'record'").get().sql)
    ) {
      db.transaction(() => {
        if (!columns.has("legacy_rowid")) {
          db.exec("ALTER TABLE record ADD COLUMN legacy_rowid INTEGER");
          db.exec(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn
            FROM record
          )
          UPDATE record
          SET legacy_rowid = (SELECT rn FROM ranked WHERE ranked.id = record.id)
          WHERE legacy_rowid IS NULL
        `);
        }
        const migratedColumns = new Set(
          db
            .prepare("PRAGMA table_info(record)")
            .all()
            .map((column) => column.name),
        );
        const invalidatedSql = migratedColumns.has("invalidated")
          ? "COALESCE(invalidated, 0)"
          : "0";
        const statusSql = migratedColumns.has("status")
          ? `CASE WHEN ${invalidatedSql} = 1 THEN 'DSQ' WHEN status IN ('DNS', 'DNF', 'DSQ') THEN status WHEN result = -1 THEN 'DNF' ELSE NULL END`
          : `CASE WHEN ${invalidatedSql} = 1 THEN 'DSQ' WHEN result = -1 THEN 'DNF' ELSE NULL END`;
        const teamId = migratedColumns.has("team_id");
        createRecordTable("record_status_v1", { teamId });
        db.exec(`
        INSERT INTO record_status_v1
          (id, name, legacy_rowid, time, num, univ, team, type, result, status,
           detail, cones, oc, scoreboard${teamId ? ", team_id" : ""})
        SELECT id, name, legacy_rowid, time, num, univ, team, type,
               CASE WHEN result = -1 THEN NULL ELSE result END,
               ${statusSql}, detail, COALESCE(cones, 0), COALESCE(oc, 0),
               COALESCE(scoreboard, CASE WHEN ${invalidatedSql} = 1 THEN 0 ELSE 1 END)
               ${teamId ? ", team_id" : ""}
        FROM record;
        DROP TABLE record;
        ALTER TABLE record_status_v1 RENAME TO record;
      `);
      })();
    }
  }

  // record 조회는 모두 legacy_rowid 또는 num 기준이라 (name, id) 인덱스는 미사용. 제거(기존 배포본 정리 포함).
  db.exec("DROP INDEX IF EXISTS idx_record_name_id");

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_record_name_legacy_rowid ON record(name, legacy_rowid)",
  );

  db.exec("CREATE INDEX IF NOT EXISTS idx_record_name_num ON record(name, num)");

  /* ============================================
   무선(LoRa) 계측 서브시스템 테이블
   - 마스터 노드에 연결된 브리지 PC가 모든 센서의 타이밍 이벤트·진단·신호등 상태를
     서버로 push, 나머지 클라이언트는 SSE로 수신. (DESIGN §9)
   ============================================ */

  // 모든 센서의 타이밍 이벤트(전부 영구 저장). master_tick은 64-bit라 TEXT로 저장(JS 정수
  // 정밀도 손실 방지). (node_id, ev_seq, master_tick) UNIQUE로 멱등 ingest.
  db.exec(`CREATE TABLE IF NOT EXISTS wireless_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT NOT NULL,
  master_tick TEXT,
  ev_seq      INTEGER,
  server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rssi        REAL,
  snr         REAL,
  link_state  TEXT
);`);

  db.exec("DROP INDEX IF EXISTS idx_wevent_server_time");

  {
    const cols = db
      .prepare("PRAGMA table_info(wireless_event)")
      .all()
      .map((c) => c.name);
    if (cols.includes("raw")) {
      db.transaction(() => {
        db.exec("DROP INDEX IF EXISTS idx_wevent_dedupe");
        db.exec(`CREATE TABLE wireless_event_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id     TEXT NOT NULL,
        master_tick TEXT,
        ev_seq      INTEGER,
        server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        rssi        REAL,
        snr         REAL,
        link_state  TEXT
      )`);
        db.exec(`INSERT INTO wireless_event_new (id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state)
        SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state FROM wireless_event`);
        db.exec("DROP TABLE wireless_event");
        db.exec("ALTER TABLE wireless_event_new RENAME TO wireless_event");
      })();
    }
  }

  // v9 evidence is retained with each raw event, including reliable checkpoints
  // and loss ranges. Old rows remain readable but cannot certify a new run.
  {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(wireless_event)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of Object.entries({
      master_boot_id: "INTEGER",
      sensor_boot_id: "INTEGER",
      capture_seq: "INTEGER",
      end_seq: "INTEGER",
      end_tick: "TEXT",
      flags: "INTEGER",
      sync_age_ms: "INTEGER",
    })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE wireless_event ADD COLUMN ${name} ${type}`);
    }
    const index = db.prepare("SELECT name FROM pragma_index_info('idx_wevent_dedupe')").all();
    if (!index.some((c) => c.name === "sensor_boot_id")) {
      db.exec("DROP INDEX IF EXISTS idx_wevent_dedupe");
      db.exec(
        "CREATE UNIQUE INDEX idx_wevent_dedupe ON wireless_event(node_id, ev_seq, master_tick, master_boot_id, sensor_boot_id)",
      );
    }
  }

  function pruneWirelessEvents() {
    const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
    if (row && row.m > RETAIN_EVENTS) {
      const active = db
        .prepare(
          "SELECT MIN(json_extract(engine_state, '$.cursorId')) AS id FROM wireless_session WHERE engine_state IS NOT NULL AND json_extract(engine_state, '$.closed') = 0",
        )
        .get();
      const cutoff = Math.min(row.m - RETAIN_EVENTS, active.id ?? Infinity);
      const removed = db.prepare("DELETE FROM wireless_event WHERE id <= ?").run(cutoff).changes;
      return { removed, cutoff };
    }
    return { removed: 0, cutoff: null };
  }

  // 센서 -> 경기·역할 매핑 (UI에서 설정, 서버 영구 저장).
  db.exec(`CREATE TABLE IF NOT EXISTS wireless_mapping (
  node_id    TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  role       TEXT NOT NULL,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

  db.exec("DROP INDEX IF EXISTS idx_wtel_node_time");

  db.exec("DROP TABLE IF EXISTS wireless_telemetry");

  // 신호등/콘솔 단일 상태(점유 잠금 + 현재 색 + green tick) + 무선 공용 설정(센서 디바운스
  // 창). 서버 재시작에도 유지. debounce_ms: 한 통과의 다중 엣지(바운스)를 접는 간격(ms).
  db.exec(`CREATE TABLE IF NOT EXISTS wireless_light (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  owner_event   TEXT,
  owner_actor   TEXT,
  light_color   TEXT,
  green_tick    TEXT,
  bridge_online INTEGER NOT NULL DEFAULT 0,
  debounce_ms   INTEGER NOT NULL DEFAULT 300,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

  db.exec(
    "INSERT OR IGNORE INTO wireless_light (id, light_color, bridge_online) VALUES (1, 'off', 0)",
  );

  // 기존 DB 마이그레이션: debounce_ms 컬럼 추가(기본 300ms).
  if (
    !db
      .prepare("PRAGMA table_info('wireless_light')")
      .all()
      .some((c) => c.name === "debounce_ms")
  ) {
    db.exec("ALTER TABLE wireless_light ADD COLUMN debounce_ms INTEGER NOT NULL DEFAULT 300");
  }

  // 기본 경기 모드 시딩 (내구 포함 — EVENT_TYPES). 탭 on/off 토글 대상.
  {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO event_mode (event_type, enabled) VALUES (?, 1)",
    );
    for (const type of EVENT_TYPES) {
      insert.run(type);
    }
    // 폐지된 경기(EVENT_TYPES에 없는) 모드행 정리 — idempotent. 과거 기록 테이블은 보존.
    db.prepare(
      `DELETE FROM event_mode WHERE event_type NOT IN (${EVENT_TYPES.map(() => "?").join(",")})`,
    ).run(...EVENT_TYPES);
  }

  // 경기별 세션 상태(서버 권위). green=arm이라 armed가 핵심 — 가상 경기 포함 모든 경기의
  // arm 상태를 전 클라가 공유(SSE wireless:session). 물리 지정 경기는 추가로 SSR을 구동하지만
  // arm 상태 자체는 여기서 단일 관리. controller/lease로 경기별 독점 제어(A안), bind-at-arm으로
  // arm 시점 팀·이벤트명 스냅샷(선택 공유는 후속 단계).
  db.exec(`CREATE TABLE IF NOT EXISTS wireless_session (
  event_type        TEXT PRIMARY KEY,
  armed             INTEGER NOT NULL DEFAULT 0,
  light_color       TEXT NOT NULL DEFAULT 'off',
  green_tick        TEXT,
  armed_at          TEXT,
  run_id            TEXT,
  saved_record_name TEXT,
  saved_record_rowid INTEGER,
  reset_pending     INTEGER NOT NULL DEFAULT 0,
  team_json         TEXT,
  event_name        TEXT,
  controller        TEXT,
  lease_expires_at  TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

  {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(wireless_session)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("run_id")) db.exec("ALTER TABLE wireless_session ADD COLUMN run_id TEXT");
    if (!columns.has("saved_record_name"))
      db.exec("ALTER TABLE wireless_session ADD COLUMN saved_record_name TEXT");
    if (!columns.has("saved_record_rowid"))
      db.exec("ALTER TABLE wireless_session ADD COLUMN saved_record_rowid INTEGER");
    if (!columns.has("reset_pending"))
      db.exec("ALTER TABLE wireless_session ADD COLUMN reset_pending INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("engine_state"))
      db.exec("ALTER TABLE wireless_session ADD COLUMN engine_state TEXT");
    const insert = db.prepare("INSERT OR IGNORE INTO wireless_session (event_type) VALUES (?)");
    for (const type of EVENT_TYPES) insert.run(type);
    // 폐지 경기 세션행 정리 — idempotent.
    db.prepare(
      `DELETE FROM wireless_session WHERE event_type NOT IN (${EVENT_TYPES.map(() => "?").join(",")})`,
    ).run(...EVENT_TYPES);
  }

  runMigrationOnce(
    db,
    "traffic.utc_timestamp_normalization.v1",
    () => {
      pruneWirelessEvents();
      for (const [table, column] of [
        ["controller", "timestamp"],
        ["wireless_event", "server_time"],
        ["wireless_mapping", "updated_at"],
        ["wireless_light", "updated_at"],
        ["wireless_session", "updated_at"],
        ["wireless_session", "armed_at"],
        ["wireless_session", "lease_expires_at"],
      ]) {
        normalizeTimestampColumn(db, table, column);
      }
    },
    { transaction: false },
  );

  // 기존 record별 동적 테이블을 단일 record 테이블로 흡수한 뒤 drop한다.
  {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${reservedSql})`,
      )
      .all();
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9가-힣 .\-_]+$/.test(name)) continue;
      const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
      const hasColumn = (col) => columns.some((c) => c.name === col);
      const hasRequired = ["time", "num", "univ", "team", "type", "result"].every(hasColumn);
      if (!hasRequired) continue;
      const detailExpr = hasColumn("detail") ? "detail" : "NULL";
      const invalidatedExpr = hasColumn("invalidated") ? "COALESCE(invalidated, 0)" : "0";
      const statusExpr = hasColumn("status")
        ? `CASE WHEN ${invalidatedExpr} = 1 THEN 'DSQ' WHEN status IN ('DNS', 'DNF', 'DSQ') THEN status WHEN result = -1 THEN 'DNF' ELSE NULL END`
        : `CASE WHEN ${invalidatedExpr} = 1 THEN 'DSQ' WHEN result = -1 THEN 'DNF' ELSE NULL END`;
      const scoreboardExpr = hasColumn("scoreboard")
        ? "COALESCE(scoreboard, 1)"
        : `CASE WHEN ${invalidatedExpr} = 1 THEN 0 ELSE 1 END`;
      const conesExpr = hasColumn("cones") ? "COALESCE(cones, 0)" : "0";
      const ocExpr = hasColumn("oc") ? "COALESCE(oc, 0)" : "0";
      db.prepare(
        `
      INSERT OR IGNORE INTO record (name, legacy_rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard)
      SELECT ?, rowid, time, num, univ, team, type,
             CASE WHEN result = -1 THEN NULL ELSE result END, ${statusExpr}, ${detailExpr},
             ${conesExpr}, ${ocExpr}, ${scoreboardExpr}
      FROM '${name}'
      ORDER BY rowid
    `,
      ).run(name);
      db.prepare("INSERT OR IGNORE INTO record_visibility (name, visible) VALUES (?, 1)").run(name);
      db.exec(`DROP TABLE '${name}'`);
    }
  }

  return { reservedSql, pruneWirelessEvents };
}
