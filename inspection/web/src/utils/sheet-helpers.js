const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV"];
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

export function catNum(i) { return ROMAN[i] || String(i + 1); }
export function subNum(i) { return String(i + 1); }
export function grpNum(i) { return String(i + 1); }
export function itemNum(i) { return CIRCLED[i] || `(${i + 1})`; }

export function getChecktableConfig(item) {
  try {
    const config = JSON.parse(item.remarks);
    return {
      columns: Array.isArray(config.columns) ? config.columns : [],
      rows: Array.isArray(config.rows) ? config.rows : [],
    };
  } catch {
    return { columns: [], rows: [] };
  }
}

export function hasCheckedChecktableCell(item, value) {
  const { columns, rows } = getChecktableConfig(item);
  return rows.some((_, rowIndex) =>
    columns.some((_, columnIndex) => Boolean(value?.[`${rowIndex}_${columnIndex}`])),
  );
}

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

export function isResponseItem(item) {
  return item?.answer_type !== "stopwatch";
}

export function isPdfItem(item) {
  return item?.answer_type !== "stopwatch";
}
