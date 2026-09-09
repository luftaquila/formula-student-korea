export function getChecktableConfig(item) {
  try {
    const config = JSON.parse(item?.remarks);
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

export function isResponseItem(item) {
  return item?.answer_type !== "stopwatch" && item?.calculation?.mode !== "computed";
}

function parseChecktableValue(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

export function getInspectionItemState(item, value) {
  if (!isResponseItem(item)) return null;
  if (item?.answer_type === "passfail") {
    if (value === "PASS") return "pass";
    if (value === "FAIL") return "fail";
    if (value === "N/A") return "na";
  }
  if (item?.answer_type === "checktable") {
    return hasCheckedChecktableCell(item, parseChecktableValue(value)) ? "answered" : "unanswered";
  }
  return String(value ?? "") ? "answered" : "unanswered";
}
