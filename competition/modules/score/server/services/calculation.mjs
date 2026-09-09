import { isTeamActive } from "../../../../lib/team-status.mjs";
import { calculateAdjustedResult } from "../../lib/adjusted-result.mjs";
import { calculateEnergyScores } from "../../lib/energy-score.mjs";

export function createScoreCalculation({ logger, options, db }) {
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

  /* ============================================
   설정
   ============================================ */
  const competitionQueries = options.competitionQueries || null;

  async function fetchYearRecords(year) {
    if (!competitionQueries?.traffic?.yearRecordGroups) {
      throw new Error("Competition Traffic query port is required");
    }
    return competitionQueries.traffic
      .yearRecordGroups(year)
      .map((row) => ({ tableName: row.name, records: row.records || [] }));
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

  // 연도별 성적 집계(엔트리·검차·경기기록·수동점수·설정). 실패 시 throw(라우트가 500 처리).
  async function computeScore(year) {
    if (
      !competitionQueries?.teams?.moduleEntries ||
      !competitionQueries?.inspection?.summary ||
      !competitionQueries?.inspection?.templateTree ||
      !competitionQueries?.inspection?.bulkAnswers ||
      !competitionQueries?.traffic?.eventModes ||
      !competitionQueries?.traffic?.yearRecordGroups
    ) {
      throw new Error("Competition in-process query ports are required");
    }
    const entries = competitionQueries.teams.moduleEntries(year);
    for (const num of Object.keys(entries)) {
      if (!isTeamActive(db, year, Number(num))) delete entries[num];
    }

    const inspection = competitionQueries.inspection.summary(year);
    const tree = competitionQueries.inspection.templateTree(year);

    // 2b. 템플릿 트리에서 코너웨이트 item ID 탐색
    let cornerWeight = null;

    if (tree) {
      const cwItems = findItemsInCategory(tree, "코너웨이트", ["공차중량", "FL", "FR", "RL", "RR"]);

      // 코너웨이트: 5개 항목 모두 존재해야 유효
      if (cwItems["공차중량"] && cwItems["FL"] && cwItems["FR"] && cwItems["RL"] && cwItems["RR"]) {
        cornerWeight = {
          categoryId: cwItems._categoryId,
          items: {
            curb: cwItems["공차중량"],
            fl: cwItems["FL"],
            fr: cwItems["FR"],
            rl: cwItems["RL"],
            rr: cwItems["RR"],
          },
          teams: {},
        };
      }

      // 벌크 답변 fetch
      const allItemIds = [];
      if (cornerWeight) allItemIds.push(...Object.values(cornerWeight.items));

      if (allItemIds.length > 0) {
        try {
          const bulkData = competitionQueries.inspection.bulkAnswers(year, allItemIds);
          if (bulkData) {
            for (const [num, items] of Object.entries(bulkData)) {
              if (cornerWeight) {
                const cw = {};
                if (items[cornerWeight.items.curb] !== undefined)
                  cw.curb = items[cornerWeight.items.curb];
                if (items[cornerWeight.items.fl] !== undefined)
                  cw.fl = items[cornerWeight.items.fl];
                if (items[cornerWeight.items.fr] !== undefined)
                  cw.fr = items[cornerWeight.items.fr];
                if (items[cornerWeight.items.rl] !== undefined)
                  cw.rl = items[cornerWeight.items.rl];
                if (items[cornerWeight.items.rr] !== undefined)
                  cw.rr = items[cornerWeight.items.rr];
                if (Object.keys(cw).length > 0) cornerWeight.teams[num] = cw;
              }
            }
          }
        } catch (e) {
          logger.warn(null, "score.fetch_bulk_answers", { error: e.message, year });
        }
      }
    }

    inspection.cornerWeight = cornerWeight;

    // 3. Traffic 서비스에서 활성화된 경기 모드 및 해당 연도의 모든 경기 기록 fetch
    let enabledModes = null;
    try {
      const modes = competitionQueries.traffic.eventModes();
      enabledModes = new Set(modes.filter((mode) => mode.enabled).map((mode) => mode.event_type));
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
          status: rec.status ?? null,
          cones: rec.cones || 0,
          oc: rec.oc || 0,
          sequence: group[num].length,
        });
      }
    }

    // 5. 페널티 설정 조회 (최고 기록 산출에 필요)
    const penaltyRows = db
      .prepare(
        "SELECT event_type, cone_penalty, oc_penalty, start_delay FROM score_penalty WHERE year = ?",
      )
      .all(year);
    const penalties = {};
    for (const row of penaltyRows) {
      penalties[row.event_type] = {
        cone_penalty: row.cone_penalty,
        oc_penalty: row.oc_penalty,
        start_delay: row.start_delay,
      };
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
        const allRuns = runs.map((r) => ({
          time: r.time,
          result: r.result,
          status: r.status,
          cones: r.cones,
          oc: r.oc,
        }));
        const finished = runs.filter(
          (r) => r.status == null && Number.isInteger(r.result) && r.result > 0,
        );
        if (finished.length) {
          // 종목 규정과 페널티를 반영한 시간 기준으로 최고 기록 선택
          const best = finished.reduce((a, b) => {
            const aAdj = calculateAdjustedResult(eventType, a, pen);
            const bAdj = calculateAdjustedResult(eventType, b, pen);
            return aAdj <= bAdj ? a : b;
          });
          records[num] = {
            result: best.result,
            status: null,
            cones: best.cones,
            oc: best.oc,
            allRuns,
          };
        } else {
          const classified = runs
            .filter((r) => r.status === "DNF" || r.status === "DSQ")
            .sort((a, b) => {
              const aTime = Date.parse(a.time || "");
              const bTime = Date.parse(b.time || "");
              const byTime =
                (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
              return byTime || b.sequence - a.sequence;
            });
          records[num] = {
            result: null,
            status: classified[0]?.status || "DNS",
            cones: 0,
            oc: 0,
            allRuns,
          };
        }
      }
      events.push({ type: eventType, records });
    }

    // 6b. 내구 기록: score_endurance 테이블에서 조회
    const enduranceRecords = {};
    const enduranceRows = db
      .prepare(
        `
      SELECT e.* FROM score_endurance e
      WHERE e.year = ? AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = e.year AND s.team_num = e.team_num
      )
    `,
      )
      .all(year)
      .filter((row) => entries[row.team_num]);
    const endurancePen = penalties["내구"] || { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
    for (const row of enduranceRows) {
      if (row.status === "DNS" || row.status === "DNF" || row.status === "DSQ") {
        enduranceRecords[row.team_num] = {
          result: null,
          status: row.status,
          cones: 0,
          oc: 0,
          allRuns: [],
        };
        continue;
      }
      // 두 드라이버 기록이 있으면 완주 기록으로 본다. 교체 초과시간 빈칸은 0초다.
      if (row.driver1_time != null && row.driver2_time != null) {
        const startDelayMs =
          ((row.driver1_start_delay || 0) + (row.driver2_start_delay || 0)) *
          (endurancePen.start_delay || 0) *
          1000;
        const manualPenaltyMs = ((row.driver1_penalty || 0) + (row.driver2_penalty || 0)) * 1000;
        const result =
          row.driver1_time +
          row.driver2_time +
          (row.driver_change_time || 0) +
          startDelayMs +
          manualPenaltyMs;
        const cones = (row.driver1_cones || 0) + (row.driver2_cones || 0);
        const oc = (row.driver1_oc || 0) + (row.driver2_oc || 0);
        enduranceRecords[row.team_num] = { result, status: null, cones, oc, allRuns: [] };
      }
      // 시간 필드 불완전 → 기록 없음 (skip)
    }
    events.push({ type: "내구", records: enduranceRecords });

    // 7. 수동 입력 점수 조회. 레거시 energy 행은 보존하되 자동계산 결과와 섞지 않는다.
    const manualRows = db
      .prepare(
        `
      SELECT m.team_num, m.score_type, m.value FROM score_manual m
      WHERE m.year = ? AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = m.year AND s.team_num = m.team_num
      )
    `,
      )
      .all(year)
      .filter((row) => entries[row.team_num]);
    const manualScores = {};
    for (const row of manualRows) {
      if (row.score_type === "energy") continue;
      if (!manualScores[row.team_num]) manualScores[row.team_num] = {};
      manualScores[row.team_num][row.score_type] = row.value;
    }

    // 8. 점수 설정 조회
    const settingRows = db
      .prepare("SELECT event_type, setting_key, value FROM score_setting WHERE year = ?")
      .all(year);
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

  return { warnThrottled, computeScore };
}
