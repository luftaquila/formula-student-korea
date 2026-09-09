import {
  runMigrationOnce,
  setupRowCapRetention,
  normalizeTimestampColumn,
} from "../../shared/server/db-setup.mjs";
import { setupMissionV2Schema } from "../lib/mission-v2.mjs";
import { seedOrientationMarkers } from "../lib/route-mode.mjs";

export function initializeSchema({ db, MISSION_TELEMETRY_MAX_ROWS, logger }) {
  db.pragma("foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

  // 코스 진행 방향(reverse)과 시작 콘(start_cone_id)을 코스 행에 저장한다. 예전에는 웹 UI가
  // localStorage에 코스별로 들고 있어 조작자·기기마다 값이 달랐다. 서버에 저장해 모든
  // 클라이언트가 같은 진행 방향/시작점을 공유하도록 한다. SQLite에 boolean 타입이 없어
  // reverse는 0/1 정수, start_cone_id는 cone.id 또는 null. 비파괴적 ADD COLUMN.
  {
    const cols = db
      .prepare("PRAGMA table_info(course)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("reverse"))
      db.exec("ALTER TABLE course ADD COLUMN reverse INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("start_cone_id"))
      db.exec("ALTER TABLE course ADD COLUMN start_cone_id INTEGER");
    if (!cols.includes("is_public"))
      db.exec(
        "ALTER TABLE course ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1))",
      );
  }

  db.exec(`CREATE TABLE IF NOT EXISTS cone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  alt REAL,
  side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id);`);

  // 기존 DB 마이그레이션: cone에 alt(고도) 컬럼 추가. 로버 RTK fix의 MSL 고도(m)를
  // lat/lng와 같은 fix에서 함께 받아 보존한다. 지도 클릭 등 수동으로 찍은 콘은 고도가
  // 없으므로 nullable. 비파괴적 ADD COLUMN(테이블 재구축·FK 영향 없음).
  {
    const cols = db
      .prepare("PRAGMA table_info(cone)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("alt")) db.exec("ALTER TABLE cone ADD COLUMN alt REAL");
  }

  // 지도 위 메모 스티커. 코스에 붙는 자유 텍스트 주석으로, 중심 좌표(lat/lng)와
  // 실측 크기(width/height, m)로 저장한다 — 콘처럼 지리 좌표에 고정돼 줌/회전에도
  // 코스 위 같은 자리를 가리키며, 크기는 m로 저장돼 줌에 따라 함께 커지고 작아진다.
  // course 삭제 시 CASCADE로 함께 지워진다.
  db.exec(`CREATE TABLE IF NOT EXISTS memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memo_course ON memo(course_id);`);

  // Ordered route guides are independent from cones: markers are physical map
  // anchors, while route_step may reference the same marker repeatedly to express
  // multi-lap or branched walks (for example a skidpad's left 2 + right 2 laps).
  db.exec(`CREATE TABLE IF NOT EXISTS route_marker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_route_marker_course ON route_marker(course_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS route_step (
  course_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  marker_id INTEGER NOT NULL,
  PRIMARY KEY (course_id, position),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE,
  FOREIGN KEY (marker_id) REFERENCES route_marker(id) ON DELETE CASCADE
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_route_step_marker ON route_step(marker_id);`);

  // 기존 DB 마이그레이션: memo에 rotation(회전 각도, deg) 추가. 비파괴적 ADD COLUMN.
  {
    const cols = db
      .prepare("PRAGMA table_info(memo)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("rotation"))
      db.exec("ALTER TABLE memo ADD COLUMN rotation REAL NOT NULL DEFAULT 0");
  }

  function ensureUtcTimestampColumns(table) {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    if (!cols.includes("created_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN created_at TEXT`);
    if (!cols.includes("updated_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
    db.prepare(
      `UPDATE ${table} SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at IS NULL OR created_at = ''`,
    ).run();
    db.prepare(
      `UPDATE ${table} SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''`,
    ).run();
  }

  runMigrationOnce(db, "course.ensure_utc_timestamp_columns.v1", () => {
    ensureUtcTimestampColumns("course");
    ensureUtcTimestampColumns("cone");
  });

  db.exec(`CREATE TABLE IF NOT EXISTS course_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  actor TEXT,
  reason TEXT,
  cones_json TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_course_snapshot ON course_snapshot(course_id, taken_at);`,
  );

  db.exec(`CREATE TABLE IF NOT EXISTS mission (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'interrupted', 'completed', 'stopped', 'error')) DEFAULT 'running',
  waypoints_json TEXT NOT NULL,
  current_waypoint_idx INTEGER NOT NULL DEFAULT 0,
  spray_results_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER,
  actor TEXT,
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_started ON mission(started_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS mission_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  fix_status TEXT,
  nav_state TEXT,
  ntrip_connected INTEGER,
  corr_age_ms INTEGER,
  ntrip_fail_count INTEGER,
  h_acc_m REAL,
  altitude_m REAL,
  v_acc_m REAL,
  FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
);`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_telemetry ON mission_telemetry(mission_id, t);`);

  setupRowCapRetention(db, "mission_telemetry", MISSION_TELEMETRY_MAX_ROWS);

  // 기존 DB 마이그레이션: mission_telemetry에 NTRIP 링크 건강도 + 측위 정확도 컬럼
  // 추가. fix_status/nav_state만으로는 "가다서다"(로버가 미션 중 정지 반복)의 원인을
  // 구분할 수 없다 — 같은 'rtk_fixed→3d_fix' 추락이라도 (a) ntrip_connected=0이면
  // 네트워크/Wi-Fi 끊김, (b) 연결됐는데 corr_age_ms가 치솟으면 캐스터/마운트포인트
  // 침묵, (c) 연결·보정 정상인데 h_acc_m/fix_status만 나쁘면 marginal sky-view 다.
  // nullable ADD COLUMN이라 비파괴적(테이블 재구축·FK 영향 없음).
  {
    const cols = db
      .prepare("PRAGMA table_info(mission_telemetry)")
      .all()
      .map((c) => c.name);
    const addColumn = (name, type) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE mission_telemetry ADD COLUMN ${name} ${type}`);
    };
    addColumn("ntrip_connected", "INTEGER"); // 0/1: 로버↔NGII 캐스터 TCP 소켓 상태
    addColumn("corr_age_ms", "INTEGER"); // 마지막 RTCM 수신 후 경과(ms). 연결됐는데 크면 캐스터 침묵
    addColumn("ntrip_fail_count", "INTEGER"); // 누적 재연결 실패 횟수
    addColumn("h_acc_m", "REAL"); // 수평 정확도(m). float 수용 게이트 판단 근거
    addColumn("altitude_m", "REAL"); // MSL 고도(m). 미션 경로의 표고 프로파일
    addColumn("v_acc_m", "REAL"); // 수직 정확도(m). 고도값 신뢰도
  }

  // 기존 DB 마이그레이션: side CHECK 제약에 'center' 추가
  {
    const info = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cone'")
      .get();
    if (info && !info.sql.includes("center")) {
      db.transaction(() => {
        // 위 alt ADD COLUMN 마이그레이션이 먼저 실행되므로 이 시점의 cone에는 항상
        // alt가 존재한다(8컬럼). cone_new에도 alt를 두고 컬럼을 명시적으로 나열해
        // 복사한다 — `SELECT *`는 cone(8) vs cone_new 컬럼 수가 어긋나면 기동 시
        // "N columns but M values were supplied"로 throw해 서비스가 뜨지 못한다.
        db.exec(`CREATE TABLE cone_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        alt REAL,
        side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      )`);
        db.exec(`INSERT INTO cone_new (id, course_id, lat, lng, alt, side, created_at, updated_at)
               SELECT id, course_id, lat, lng, alt, side, created_at, updated_at FROM cone`);
        db.exec(`DROP TABLE cone`);
        db.exec(`ALTER TABLE cone_new RENAME TO cone`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id)`);
      })();
    }
  }

  // 기존 DB 마이그레이션: mission에 paused/interrupted 상태 + 진행상황 영속 컬럼
  // (current_waypoint_idx, spray_results_json, updated_at) 추가. 이전 버전은 진행
  // 인덱스를 in-memory로만 들고 있어 로버 SSE 끊김 한 번에 미션 진행이 통째로
  // 유실됐다. 이제 DB에 영속화해 끊김/새로고침/서버 재시작에도 재개 가능.
  {
    const info = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mission'")
      .get();
    if (
      info &&
      (!info.sql.includes("current_waypoint_idx") || !info.sql.includes("'interrupted'"))
    ) {
      // CRITICAL: disable FK enforcement around the table rebuild. mission_telemetry
      // has `FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE`, so
      // `DROP TABLE mission` under foreign_keys=ON would cascade-delete the ENTIRE
      // telemetry history before the rename. PRAGMA foreign_keys cannot be toggled
      // inside a transaction, so we toggle it around the whole block — this is
      // exactly the procedure SQLite's docs prescribe for a rename-based rebuild of
      // a table that other tables reference. (The cone migration above is safe
      // without this only because nothing FK-references cone.)
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(`CREATE TABLE mission_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course_id INTEGER,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'interrupted', 'completed', 'stopped', 'error')) DEFAULT 'running',
          waypoints_json TEXT NOT NULL,
          current_waypoint_idx INTEGER NOT NULL DEFAULT 0,
          spray_results_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER,
          actor TEXT,
          FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
        )`);
          db.exec(`INSERT INTO mission_new
                   (id, course_id, started_at, ended_at, status, waypoints_json, actor)
                 SELECT id, course_id, started_at, ended_at, status, waypoints_json, actor FROM mission`);
          db.exec(`DROP TABLE mission`);
          db.exec(`ALTER TABLE mission_new RENAME TO mission`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_started ON mission(started_at)`);
        })();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
  }

  runMigrationOnce(db, "course.utc_timestamp_normalization.v1", () => {
    for (const [table, column] of [
      ["course", "created_at"],
      ["course", "updated_at"],
      ["cone", "created_at"],
      ["cone", "updated_at"],
    ]) {
      normalizeTimestampColumn(db, table, column);
    }
  });

  // Durable mission protocol v2: stable waypoint identities, editable remaining
  // routes, command acknowledgements, and named route presets. The migration is
  // additive and backfills legacy coordinate arrays without deleting history.
  setupMissionV2Schema(db, logger);

  // 주행 마커가 코스의 유일한 방향 지정 수단이 되면서, 마커가 없는 기존 코스는 UI에서
  // 방향을 바꿀 수단을 잃는다. 그래서 저장된 start_cone_id/reverse를 그대로 재현하는
  // 마커 2개를 코스마다 심어 둔다. 두 번째 마커는 루프의 1/3 지점에 놓이므로
  // resolveCourseRoute의 "첫 구간은 짧은 호" 규칙이 원래 방향을 되돌려 준다.
  // 기하는 바뀌지 않는다 — 마커는 computeCenterline의 start/reverse 입력일 뿐이다.
  runMigrationOnce(db, "course.seed_route_markers_from_direction.v1", () => {
    const courses = db.prepare("SELECT id, reverse, start_cone_id FROM course").all();
    const insertMarker = db.prepare(
      "INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)",
    );
    const insertStep = db.prepare(
      "INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)",
    );
    let seeded = 0,
      skipped = 0;
    for (const course of courses) {
      // 이미 마커를 하나라도 놓은 코스는 건드리지 않는다. 방문 순서를 아직 만들지
      // 않았을 뿐 누군가 경로를 작성하는 중이며, 여기서 마커 2개를 더 심으면 그 작업을
      // 어지럽히고 의도하지 않은 2단계 순서로 코스를 oriented로 바꿔 버린다.
      if (db.prepare("SELECT 1 FROM route_marker WHERE course_id = ? LIMIT 1").get(course.id))
        continue;
      const cones = db
        .prepare("SELECT id, lat, lng, side, alt FROM cone WHERE course_id = ? ORDER BY id")
        .all(course.id);
      const startCone =
        course.start_cone_id != null
          ? cones.find((cone) => cone.id === course.start_cone_id)
          : null;
      const positions = seedOrientationMarkers(cones, {
        ...(startCone ? { start: { lat: startCone.lat, lng: startCone.lng } } : {}),
        reverse: !!course.reverse,
      });
      // 루프로 닫히지 않는 코스(콘 부족, 미완성 배치)는 건드리지 않는다. 마커가 없으면
      // 계속 저장된 start/reverse로 계산되므로 동작이 달라지지 않는다.
      if (!positions) {
        skipped++;
        continue;
      }
      positions.forEach((position, index) => {
        const markerId = insertMarker.run(
          course.id,
          position.lat,
          position.lng,
          index === 0 ? "시작" : "방향",
        ).lastInsertRowid;
        insertStep.run(course.id, index, markerId);
      });
      seeded++;
    }
    logger.log(null, "course.route.seed", { seeded, skipped, courses: courses.length }, null, {
      email: "system",
      name: "system",
      role: "admin",
    });
  });

  // GPS 소스/기준국 설정. 로버가 쓸 NTRIP 소스(NGII vs 수신기 base station)를 서버에
  // 저장해 모든 클라이언트·로버 재연결 간에 공유한다. key-value 단순 저장:
  //   ntrip_source          "ngii" | "base" (기본 ngii)
  //   active_base_point_id  survey_point.id (base 소스일 때 사용할 기준점) | null
  db.exec(`CREATE TABLE IF NOT EXISTS gps_config (
  key TEXT PRIMARY KEY,
  value TEXT
);`);

  // 측량점: 수신기를 기준국으로 쓰기 위한 이름 붙은 지점. NGII RTK가 살아있을 때
  // 수신기 위치를 일정 시간 평균내어(lat/lng/alt) 기록해 두고, 같은 자리에 두면
  // 그 좌표로 수신기를 고정 기준국(F9P TMODE3 FIXED)으로 돌린다. lat/lng/alt는
  // 미측량 시 NULL, double 정밀도로 TMODE3 LLH 재구성에 충분하다.
  db.exec(`CREATE TABLE IF NOT EXISTS survey_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  lat REAL,
  lng REAL,
  alt REAL,
  h_acc_m REAL,
  samples INTEGER,
  surveyed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
}
