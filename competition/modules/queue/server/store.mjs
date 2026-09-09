import { currentCompetitionYear } from "../../../../shared/common/competition-year.mjs";
import { validateYear } from "../../../../shared/common/validation.mjs";

export function createQueueStore({
  options,
  logger,
  db,
  inspections,
  INSPECTION_SETTING_FIELDS,
  normalizeInspectionSetting,
  inspectionSettingKey,
  INSPECTIONS,
}) {
  /* ============================================
   Express 앱 설정
   ============================================ */
  function currentYear() {
    return currentCompetitionYear();
  }

  function activeTeam(num, year = currentYear()) {
    if (options.teamStore) {
      return options.teamStore.getByNumber(year, num, { includeInactive: false });
    }
    return { id: null, year, number: num, active: true };
  }

  function requestTeamActivity(req, res, { action, num, year = currentYear() }) {
    try {
      const team = activeTeam(num, year);
      return { ok: true, active: !!team, team };
    } catch (error) {
      logger.warn(
        req,
        action,
        {
          error: error?.message || String(error),
          phase: "canonical_team_lookup",
          year,
          team_num: num,
        },
        `#${num}`,
      );
      res.status(500).send("팀 활성 상태를 확인할 수 없습니다.");
      return { ok: false, active: false };
    }
  }

  function parseYearQuery(value) {
    if (value == null || value === "") return currentYear();
    const check = validateYear(value);
    return check.valid ? check.value : null;
  }

  function withInspectionLengths(rows, year = currentYear()) {
    // 행마다 COUNT(*)를 돌리는 N+1 대신 한 번의 GROUP BY로 길이를 집계한다.
    const counts = new Map();
    for (const r of db
      .prepare(
        "SELECT inspection, COUNT(*) AS count FROM inspection_queue WHERE year = ? GROUP BY inspection",
      )
      .all(year)) {
      counts.set(r.inspection, r.count);
    }
    // rowid(= 최초 삽입 순서)가 아니라 INSPECTIONS 키 순서로 노출한다. 기존 DB의
    // 삽입 순서가 달라도 모든 화면이 같은 순서를 본다.
    const order = Object.keys(inspections);
    return rows
      .filter((row) => order.includes(row.type))
      .map((row) => ({ ...row, length: counts.get(row.type) || 0 }))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }

  function getActiveInspections(year = currentYear()) {
    return withInspectionLengths(
      db
        .prepare(
          `
    SELECT type, name, active, ignore_priority, ignore_reinspection, hidden_from_register
    FROM inspection
    WHERE active = TRUE
  `,
        )
        .all(),
      year,
    );
  }

  function getAllInspections(year = currentYear()) {
    return withInspectionLengths(db.prepare("SELECT * FROM inspection").all(), year).map(
      (inspection) => {
        const settings = getInspectionSettings(inspection.type);
        return {
          ...inspection,
          sms: settings.sms ? 1 : 0,
          sms_rank: settings.smsRank,
          cancel_penalty: settings.cancelPenalty,
        };
      },
    );
  }

  function getInspectionSettings(type) {
    if (!Object.hasOwn(inspections, type)) return null;
    const values = Object.fromEntries(
      INSPECTION_SETTING_FIELDS.map((field) => [
        field,
        normalizeInspectionSetting(
          field,
          db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get(inspectionSettingKey(type, field))?.value,
        ),
      ]),
    );
    return {
      sms: values.sms === "TRUE",
      smsRank: Number(values.sms_rank),
      cancelPenalty: Number(values.cancel_penalty),
    };
  }

  function getCurrentEntry(num, year) {
    const rows = db
      .prepare(
        `
    SELECT inspection, phone
    FROM current_inspection
    WHERE num = ? AND year = ?
    ORDER BY rowid
  `,
      )
      .all(num, year);
    if (rows.length > 0) {
      return {
        num,
        phone: rows[0].phone,
        inspection: rows.map((row) => row.inspection).join(","),
        inspections: rows.map((row) => row.inspection),
        year,
      };
    }
    return null;
  }

  function setCurrentInspections(num, phone, types, year) {
    const uniqueTypes = [...new Set(types.filter((type) => INSPECTIONS[type]))];
    db.prepare("DELETE FROM current_inspection WHERE num = ? AND year = ?").run(num, year);
    if (uniqueTypes.length === 0) return;
    const insert = db.prepare(
      "INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)",
    );
    for (const type of uniqueTypes) insert.run(num, type, phone, year);
  }

  function addCurrentInspection(num, phone, type, year) {
    const current = getCurrentEntry(num, year);
    if (!current) {
      setCurrentInspections(num, phone, [type], year);
      return;
    }

    const currentTypes = current.inspections;
    if (currentTypes.includes(type)) {
      throw { status: 400, message: `이미 ${inspections[type]} 검차에 등록된 엔트리입니다.` };
    }

    // 보고서는 다른 검차와 항상 동시 등록 가능
    if (type === "report") {
      setCurrentInspections(num, phone, [...currentTypes, type], year);
      return;
    }

    const nonReportTypes = currentTypes.filter((inspection) => inspection !== "report");
    if (
      nonReportTypes.length === 0 ||
      (nonReportTypes.length === 1 && nonReportTypes[0] === "battery" && type === "chassis") ||
      (nonReportTypes.length === 1 && nonReportTypes[0] === "chassis" && type === "battery")
    ) {
      // 보고서만 등록 또는 축전지+섀시 동시 등록 허용
      setCurrentInspections(num, phone, [...currentTypes, type], year);
      return;
    }

    const name = currentTypes.map((inspection) => inspections[inspection]).join(", ");
    throw { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
  }

  function insertQueueRow(type, num, phone, timestamp, year) {
    db.prepare(
      "INSERT INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)",
    ).run(type, num, phone, timestamp, year);
  }

  function deleteQueueRow(type, num, year) {
    return db
      .prepare("DELETE FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?")
      .run(type, num, year);
  }

  function getQueueRow(type, num, year) {
    return db
      .prepare(
        "SELECT num, phone, timestamp, year FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?",
      )
      .get(type, num, year);
  }

  /* ============================================
   DB 헬퍼
   ============================================ */
  /**
   * 대기열 조회 쿼리 (정렬 순서: 초검 > 재검, 우선순위 높음 > 낮음, 선착순)
   * 파라미터 순서: [inspection, year] × 3 (재검 CASE, priority JOIN, WHERE 순)
   *
   * 정렬 변형은 (ignore_reinspection, ignore_priority) 조합당 4종뿐이므로 prepared
   * statement를 메모이즈한다 — 핫패스(등록/취소/입장/SMS/조회)의 매 요청 SQL
   * 재컴파일과 메타 조회 statement 재생성을 피한다.
   */
  const inspectionMetaStmt = db.prepare(
    "SELECT ignore_priority, ignore_reinspection FROM inspection WHERE type = ?",
  );

  const queueStmtCache = new Map();

  function getQueueOrderFlags(inspection) {
    const meta = inspectionMetaStmt.get(inspection);
    return {
      ignoreReinspection: !!meta?.ignore_reinspection,
      ignorePriority: !!meta?.ignore_priority,
    };
  }

  function buildQueueQuery({ ignoreReinspection, ignorePriority }, variant) {
    const overallOrderClauses = [];
    if (!ignoreReinspection) overallOrderClauses.push("is_reinspection ASC");
    if (!ignorePriority) overallOrderClauses.push("priority ASC");
    overallOrderClauses.push("timestamp ASC", "num ASC");

    const groupOrderClauses = [];
    if (!ignorePriority) groupOrderClauses.push("priority ASC");
    groupOrderClauses.push("timestamp ASC", "num ASC");

    return `
    WITH queue_base AS (
      SELECT t.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ? AND h.year = ?
        ) THEN 1 ELSE 0 END AS is_reinspection,
        COALESCE(p.priority, 999) AS priority
      FROM inspection_queue AS t
      LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ? AND p.year = ?
      WHERE t.inspection = ? AND t.year = ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = t.year AND s.team_num = t.num
        )
    ), ranked_queue AS (
      SELECT queue_base.*,
        ROW_NUMBER() OVER (ORDER BY ${overallOrderClauses.join(", ")}) AS rank,
        COUNT(*) OVER () AS total,
        ROW_NUMBER() OVER (
          PARTITION BY is_reinspection
          ORDER BY ${groupOrderClauses.join(", ")}
        ) AS group_rank,
        COUNT(*) OVER (PARTITION BY is_reinspection) AS group_total
      FROM queue_base
    )
    SELECT * FROM ranked_queue
    ${variant === "rank" ? "WHERE num = ?" : "ORDER BY rank"}
  `;
  }

  // variant: "list"(전체 목록) | "offset"(순번 단건) | "rank"(엔트리 단건)
  function getQueueStmt(inspection, variant = "list") {
    const flags = getQueueOrderFlags(inspection);
    const key = `${flags.ignoreReinspection}|${flags.ignorePriority}|${variant}`;
    let stmt = queueStmtCache.get(key);
    if (!stmt) {
      stmt = db.prepare(
        buildQueueQuery(flags, variant) + (variant === "offset" ? " LIMIT 1 OFFSET ?" : ""),
      );
      queueStmtCache.set(key, stmt);
    }
    return stmt;
  }

  function getQueueParams(inspection, year) {
    return [inspection, year, inspection, year, inspection, year];
  }

  function getQueueRankRow(inspection, num, year) {
    return getQueueStmt(inspection, "rank").get(...getQueueParams(inspection, year), num);
  }

  /* ============================================
   API 라우트: Admin - 부스 관리
   ============================================ */

  // 부스 목록 조회 헬퍼
  function getBoothsForType(type) {
    return db
      .prepare(
        `
    SELECT booth_num, active, occupied_by, entered_at, timer_paused_at, timer_paused_ms
    FROM booth WHERE inspection = ? ORDER BY booth_num
  `,
      )
      .all(type);
  }

  /* ============================================
   유틸리티 함수
   ============================================ */
  async function getEntries() {
    if (!options.teamStore) throw new Error("Competition team store is required");
    return options.teamStore.moduleEntries(currentYear());
  }

  return {
    currentYear,
    requestTeamActivity,
    parseYearQuery,
    getActiveInspections,
    getAllInspections,
    getInspectionSettings,
    getCurrentEntry,
    setCurrentInspections,
    addCurrentInspection,
    insertQueueRow,
    deleteQueueRow,
    getQueueRow,
    getQueueStmt,
    getQueueParams,
    getQueueRankRow,
    getBoothsForType,
    getEntries,
  };
}
