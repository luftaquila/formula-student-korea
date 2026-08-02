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
