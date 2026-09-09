import {
  getChecktableConfig,
  hasCheckedChecktableCell,
  isResponseItem,
  getInspectionItemState,
} from "../../../lib/item-status.mjs";

export {
  getChecktableConfig,
  hasCheckedChecktableCell,
  isResponseItem,
  getInspectionItemState,
};

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV"];
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

export function catNum(i) { return ROMAN[i] || String(i + 1); }
export function subNum(i) { return String(i + 1); }
export function grpNum(i) { return String(i + 1); }
export function itemNum(i) { return CIRCLED[i] || `(${i + 1})`; }

export function nextCounterValue(value, delta) {
  const parsed = Number(value);
  const current = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  return String(Math.max(0, current + delta));
}

export function normalizeCounterInput(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+(?=\d)/, "");
}

export function normalizeMemo(value) {
  const memo = String(value ?? "");
  return memo.trim() ? memo : "";
}

export function formatStopwatchElapsed(elapsedMs) {
  const totalMilliseconds = Math.floor(Math.max(0, Number(elapsedMs) || 0));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  return hours ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

export function buildInspectionStatusMap(category, answers = {}) {
  const counts = { pass: 0, fail: 0, na: 0, answered: 0, unanswered: 0 };
  const subcategories = (category?.subcategories || []).map((sub, subIndex) => ({
    id: sub.id,
    name: sub.name,
    number: subNum(subIndex),
    groups: (sub.groups || []).map((group, groupIndex) => {
      const items = (group.items || []).flatMap((item, itemIndex) => {
        const value = answers[item.id]?.value ?? "";
        const state = getInspectionItemState(item, value);
        if (!state) return [];
        counts[state] += 1;
        return [{
          id: item.id,
          name: item.name,
          number: itemNum(itemIndex),
          state,
        }];
      });
      return {
        id: group.id,
        name: group.name,
        number: grpNum(groupIndex),
        items,
      };
    }),
  }));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const completed = total - counts.unanswered;
  return {
    subcategories,
    counts,
    completed,
    total,
    complete: completed === total,
    percent: total ? Math.floor((completed / total) * 100) : 100,
  };
}

export function isPdfItem(item) {
  return item?.answer_type !== "stopwatch";
}

export function isMultiSourceCalculation(operation) {
  return operation === "sum" || operation === "product";
}

export function calculationForMode(current, mode, fallback) {
  if (mode === "manual") return null;
  if (current) return { ...current, mode };
  return fallback;
}

export function calculationSourcesForOperation(sources, operation, availableKeys) {
  const available = new Set(availableKeys || []);
  const valid = (sources || []).filter(key => available.has(key));
  return isMultiSourceCalculation(operation) ? valid : valid.slice(0, 1);
}
