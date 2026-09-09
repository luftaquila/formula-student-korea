import { parseCalculationConfig } from "../../lib/calculations.mjs";
import { parseStoredRuleRefs } from "../../lib/rule-refs.mjs";

export function createTemplateService({ db, logger }) {
  /* ============================================
   API 라우트: 검차 시트
   ============================================ */

  // excluded_types는 DB에 JSON 문자열로 저장하고 API에서는 항상 배열로 주고받는다.
  const MAX_EXCLUDED_TYPES = 50;

  function parseExcludedTypes(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
    } catch {
      return []; // 손상된 값은 "제외 없음"으로 취급 — 카테고리가 조용히 사라지지 않게 한다.
    }
  }

  // 유효한 배열이면 저장용 JSON 문자열, 아니면 null(= 400 처리 대상)을 반환한다.
  function normalizeExcludedTypes(value) {
    if (!Array.isArray(value)) return null;
    const names = [
      ...new Set(
        value
          .filter((t) => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    if (names.length > MAX_EXCLUDED_TYPES) return null;
    return JSON.stringify(names);
  }

  function getTemplateTree(year, req = null) {
    const rows = db
      .prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY sort_order")
      .all(year);
    // 저장 형식(JSON 문자열)이 응답에 새지 않도록 모든 레벨에서 배열로 정규화한다.
    // 카테고리 외의 레벨은 항상 빈 배열이다.
    for (const r of rows) {
      r.excluded_types = parseExcludedTypes(r.excluded_types);
      r.calculation = parseCalculationConfig(r.calculation);
      if (r.level !== "item") {
        delete r.rule_refs;
        continue;
      }
      try {
        r.rule_refs = parseStoredRuleRefs(r.rule_refs, r.year);
      } catch (error) {
        // 한 문항의 저장 데이터가 깨져도 연도 전체 검차표를 막지 않는다. 링크는 닫힌 상태(검토 필요)로 보인다.
        if (req)
          logger.warn(
            req,
            "template.read",
            { error: error.message, item_id: r.id, year: r.year, phase: "stored_rule_refs" },
            `template:${r.id}`,
          );
        r.rule_refs = { status: "needs_review", references: [] };
      }
    }
    const nodeMap = {};
    const tree = [];

    // Pass 1: create all nodes
    for (const r of rows) {
      if (r.level === "category") {
        nodeMap[r.id] = { ...r, subcategories: [] };
      } else if (r.level === "subcategory") {
        nodeMap[r.id] = { ...r, groups: [] };
      } else if (r.level === "group") {
        nodeMap[r.id] = { ...r, items: [] };
      }
    }

    // Pass 2: link to parents (order-independent)
    for (const r of rows) {
      if (r.level === "category") {
        tree.push(nodeMap[r.id]);
      } else if (r.level === "subcategory") {
        const parent = nodeMap[r.parent_id];
        if (parent) parent.subcategories.push(nodeMap[r.id]);
      } else if (r.level === "group") {
        const parent = nodeMap[r.parent_id];
        if (parent) parent.groups.push(nodeMap[r.id]);
      } else if (r.level === "item") {
        const parent = nodeMap[r.parent_id];
        if (parent) parent.items.push(r);
      }
    }
    return tree;
  }

  // sheet_template CHECK 제약과 동기화된 허용값 — 라우트에서 미리 걸러 CHECK 위반 500 대신
  // 사람이 읽을 수 있는 400을 반환한다(DDL 변경 시 이 목록도 함께 갱신).
  const TEMPLATE_LEVELS = ["category", "subcategory", "group", "item"];

  const TEMPLATE_ANSWER_TYPES = [
    "passfail",
    "number",
    "text",
    "checktable",
    "counter",
    "stopwatch",
  ];

  function normalizeStoredCounterAnswer(value) {
    const match = String(value ?? "").match(/^(\d+)(?:\.0+)?$/);
    if (!match) return "";
    return match[1].replace(/^0+(?=\d)/, "");
  }

  return {
    parseExcludedTypes,
    normalizeExcludedTypes,
    getTemplateTree,
    TEMPLATE_LEVELS,
    TEMPLATE_ANSWER_TYPES,
    normalizeStoredCounterAnswer,
  };
}
