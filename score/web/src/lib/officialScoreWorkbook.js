import { calculateAdjustedResult } from "../../../lib/adjusted-result.mjs";

export const OFFICIAL_EVENT_TYPES = Object.freeze(["가속", "스키드패드", "오토크로스"]);
export const STARTING_ORDER_FIRST_GROUP_SIZE = 7;

const RUN_LIMIT = 4;
const COLORS = Object.freeze({
  alternateRow: "F2F7FC",
  blue: "2F75B5",
  border: "B4C6E7",
  combustion: "C65911",
  electric: "0070C0",
  groupOne: "FFF2CC",
  headerText: "FFFFFF",
  paleYellow: "FFF2CC",
  rank: "E2F0D9",
  text: "000000",
  yellow: "FFFF00",
});

function round2(value) {
  return Number(Number(value).toFixed(2));
}

function formatPoints(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(round2(number));
}

export function formatOfficialResult(result) {
  if (result == null || result === "") return "";
  const milliseconds = Number(result);
  if (!Number.isFinite(milliseconds)) return String(result);

  const rounded = Math.round(Math.abs(milliseconds));
  const minutes = Math.floor(rounded / 60_000);
  const seconds = Math.floor(rounded / 1_000) % 60;
  const millis = rounded % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatRunResult(eventType, run, penalty, adjusted) {
  if (!run) return "";
  if (run.status) return run.status;
  const result = adjusted
    ? calculateAdjustedResult(eventType, run, penalty)
    : eventType === "스키드패드" && run.result != null
      ? Number(run.result) / 2
      : run.result;
  return formatOfficialResult(result);
}

function sortedEntries(entries) {
  return Object.entries(entries || {})
    .map(([num, entry]) => ({ num: Number(num), ...entry }))
    .sort((a, b) => a.num - b.num);
}

function competitionRanks(items, resultOf, keyOf) {
  const ranked = items
    .map((item) => ({ item, result: resultOf(item) }))
    .filter(({ result }) => Number.isFinite(result))
    .sort((left, right) => left.result - right.result || Number(keyOf(left.item)) - Number(keyOf(right.item)));
  const ranks = new Map();
  let previousResult = null;
  let previousRank = null;
  ranked.forEach(({ item, result }, index) => {
    const rank = previousResult !== null && result === previousResult ? previousRank : index + 1;
    ranks.set(keyOf(item), rank);
    previousResult = result;
    previousRank = rank;
  });
  return ranks;
}

function eventByType(events, eventType) {
  return (events || []).find((event) => event.type === eventType) || { type: eventType, records: {} };
}

function buildEventSheet(entries, events, penalties, eventType) {
  const event = eventByType(events, eventType);
  const penalty = penalties?.[eventType] || {};
  const detailedRuns = eventType !== "가속";
  const entriesInOrder = sortedEntries(entries);
  const ranks = competitionRanks(
    entriesInOrder,
    (entry) => calculateAdjustedResult(eventType, event.records?.[entry.num], penalty),
    (entry) => entry.num,
  );
  const headers = ["번호", "학교", "팀", "유형", "순위", "최고 기록"];

  for (let index = 1; index <= RUN_LIMIT; index++) {
    if (detailedRuns) {
      headers.push(
        `기록 ${index}`,
        `기록 ${index}\n콘터치`,
        `기록 ${index}\n코스이탈`,
        `기록 ${index}\n최종`,
      );
    } else {
      headers.push(`기록 ${index}`);
    }
  }

  const rows = entriesInOrder.map((entry) => {
    const record = event.records?.[entry.num] || null;
    const values = [
      entry.num,
      entry.univ || "",
      entry.team || "",
      entry.type || "",
      ranks.get(entry.num) || "",
      formatRunResult(eventType, record, penalty, true),
    ];
    const runs = record?.allRuns || [];

    for (let index = 0; index < RUN_LIMIT; index++) {
      const run = runs[index];
      if (!detailedRuns) {
        values.push(formatRunResult(eventType, run, penalty, true));
      } else if (!run) {
        values.push("", "", "", "");
      } else {
        values.push(
          formatRunResult(eventType, run, penalty, false),
          run.cones ?? 0,
          run.oc ?? 0,
          formatRunResult(eventType, run, penalty, true),
        );
      }
    }

    return { values, vehicleType: entry.type || "" };
  });

  return {
    kind: "event",
    name: eventType,
    headers,
    rows,
    widths: detailedRuns
      ? [8, 31.71, 24, 14, 9, ...Array.from({ length: 17 }, () => 11)]
      : [8, 30.71, 24, 14, 9, ...Array.from({ length: 5 }, () => 17)],
    rankColumn: 5,
    bestColumn: 6,
  };
}

export function calculateEnduranceTimes(row, penalty = {}) {
  if (row?.driver1_time == null || row?.driver2_time == null) {
    return { driving: null, penaltyTime: null, final: null };
  }

  const driving = Number(row.driver1_time)
    + Number(row.driver2_time)
    + Number(row.driver_change_time || 0);
  const penaltyTime = (
    (Number(row.driver1_start_delay || 0) + Number(row.driver2_start_delay || 0))
      * Number(penalty.start_delay || 0)
    + Number(row.driver1_penalty || 0)
    + Number(row.driver2_penalty || 0)
    + (Number(row.driver1_cones || 0) + Number(row.driver2_cones || 0))
      * Number(penalty.cone_penalty || 0)
    + (Number(row.driver1_oc || 0) + Number(row.driver2_oc || 0))
      * Number(penalty.oc_penalty || 0)
  ) * 1000;

  return { driving, penaltyTime, final: driving + penaltyTime };
}

function buildEnduranceSheet(entries, endurance, penalties) {
  const penalty = penalties?.["내구"] || {};
  const qualified = Object.entries(endurance || {})
    .filter(([num, row]) => row?.qualified && entries?.[num])
    .sort(([left], [right]) => Number(left) - Number(right));
  const ranks = competitionRanks(
    qualified,
    ([, row]) => row.status ? null : calculateEnduranceTimes(row, penalty).final,
    ([num]) => Number(num),
  );

  const rows = qualified.map(([num, row]) => {
    const entry = entries[num];
    const times = calculateEnduranceTimes(row, penalty);
    const classified = Boolean(row.status);
    return {
      vehicleType: entry.type || "",
      values: [
        Number(num),
        entry.univ || "",
        entry.team || "",
        ranks.get(Number(num)) || "",
        row.status || formatOfficialResult(times.final),
        classified ? "" : formatOfficialResult(times.driving),
        classified ? "" : formatOfficialResult(times.penaltyTime),
        formatOfficialResult(row.driver1_time),
        row.driver1_start_delay ?? "",
        row.driver1_cones ?? "",
        row.driver1_oc ?? "",
        row.driver1_penalty ?? "",
        formatOfficialResult(row.driver_change_time),
        formatOfficialResult(row.driver2_time),
        row.driver2_start_delay ?? "",
        row.driver2_cones ?? "",
        row.driver2_oc ?? "",
        row.driver2_penalty ?? "",
      ],
    };
  });

  return {
    kind: "endurance",
    name: "내구",
    headerRows: [
      ["엔트리", "학교", "팀명", "순위", "최종 기록", "주행시간", "페널티", "드라이버1", "", "", "", "", "드라이버 교체\n초과시간", "드라이버2", "", "", "", ""],
      ["", "", "", "", "", "", "", "기록", "출발지연\n1회:2분", "콘터치\n1개:2초", "코스이탈\n1회:20초", "페널티\n(초)", "", "기록", "출발지연\n1회:2분", "콘터치\n1개:2초", "코스이탈\n1회:20초", "페널티\n(초)"],
    ],
    merges: ["A1:A2", "B1:B2", "C1:C2", "D1:D2", "E1:E2", "F1:F2", "G1:G2", "H1:L1", "M1:M2", "N1:R1"],
    rows,
    widths: [8, 27, 31, 9, 15, 15, 15, 14, 11, 11, 12, 11, 15, 14, 11, 11, 12, 11],
    rankColumn: 4,
    bestColumn: 5,
  };
}

function validRuns(record) {
  return (record?.allRuns || []).filter((run) => (
    !run.status && Number.isInteger(run.result) && run.result > 0
  ));
}

function buildStartingOrderSheet(entries, events, endurance) {
  const eventType = "오토크로스";
  const event = eventByType(events, eventType);
  const teams = Object.entries(endurance || {})
    .filter(([num, row]) => row?.qualified && entries?.[num])
    .map(([num]) => {
      const teamNum = Number(num);
      const entry = entries[num];
      const record = event.records?.[teamNum] || null;
      const finished = validRuns(record);
      const bestRaw = finished.reduce((best, run) => (
        !best || run.result < best.result ? run : best
      ), null);
      return {
        bestRaw,
        entry,
        num: teamNum,
        record,
      };
    })
    .sort((left, right) => {
      if (left.bestRaw && right.bestRaw) return left.bestRaw.result - right.bestRaw.result || left.num - right.num;
      if (left.bestRaw) return -1;
      if (right.bestRaw) return 1;
      return left.num - right.num;
    });

  const rows = teams.map((team, index) => {
    const group = index < STARTING_ORDER_FIRST_GROUP_SIZE ? 1 : 2;
    const groupOrder = group === 1 ? index + 1 : index - STARTING_ORDER_FIRST_GROUP_SIZE + 1;
    return {
      group,
      vehicleType: team.entry.type || "",
      values: [
        `${group}그룹`,
        groupOrder,
        team.num,
        team.entry.univ || "",
        team.entry.team || "",
        team.entry.type || "",
        team.bestRaw
          ? formatOfficialResult(team.bestRaw.result)
          : (team.record?.status || "DNS"),
      ],
    };
  });

  const groupRanges = [];
  for (const group of [1, 2]) {
    const first = rows.findIndex((row) => row.group === group);
    const last = rows.findLastIndex((row) => row.group === group);
    if (first !== -1) groupRanges.push({ group, startRow: first + 2, endRow: last + 2 });
  }

  return {
    kind: "startingOrder",
    name: "스타팅오더",
    headers: ["그룹", "출발 순서", "엔트리", "학교명", "팀명", "차량 유형", "랩타임"],
    groupRanges,
    rows,
    widths: [10, 12.14, 9, 27, 29, 14, 18],
  };
}

function buildOverallSheet(score, scoreCache) {
  const entries = score.entries || {};
  const cornerWeightCategoryId = score.inspection?.cornerWeight?.categoryId;
  const categories = (score.inspection?.categories || [])
    .filter((category) => category.id !== cornerWeightCategoryId);
  const inspectionTeams = score.inspection?.teams || {};
  const scoredEvents = [...OFFICIAL_EVENT_TYPES, "내구"];
  const scoreColumns = ["보고서", ...scoredEvents, "에너지 효율"];
  const scoreTotals = [
    score.settings?.["보고서"]?.total || 0,
    ...scoredEvents.map((eventType) => score.settings?.[eventType]?.total || 0),
    score.settings?.["에너지"]?.total || 0,
  ];

  const inspectionStart = 5;
  const inspectionEnd = inspectionStart + categories.length - 1;
  const rankColumn = inspectionEnd + 1;
  const finalColumn = rankColumn + 1;
  const evaluationStart = finalColumn + 1;
  const evaluationEnd = evaluationStart + scoreColumns.length - 1;
  const subtotalColumn = evaluationEnd + 1;
  const deductionColumn = subtotalColumn + 1;
  const bonusColumn = deductionColumn + 1;
  const reasonColumn = bonusColumn + 1;
  const pointTotal = scoreTotals.reduce((sum, value) => sum + Number(value || 0), 0);
  const entriesInOrder = sortedEntries(entries);
  const ranks = competitionRanks(
    entriesInOrder,
    (entry) => -Number(scoreCache.totalScoreMap?.[String(entry.num)] || 0),
    (entry) => entry.num,
  );

  const firstHeader = ["엔트리", "학교", "팀명", "차량 유형"];
  if (categories.length) firstHeader.push("실격사항", ...Array.from({ length: categories.length - 1 }, () => ""));
  firstHeader.push(
    "순위",
    "최종 점수\n(①-②+③)",
    "평가항목 (득점)",
    ...Array.from({ length: scoreColumns.length - 1 }, () => ""),
    `① 소계\n(${formatPoints(pointTotal)}점)`,
    "② 감점",
    "③ 가점",
    "감점 및 가점 사유",
  );
  const secondHeader = ["", "", "", ""];
  secondHeader.push(...categories.map((category) => category.name));
  secondHeader.push(
    "",
    "",
    ...scoreColumns.map((name, index) => `${name}\n(${formatPoints(scoreTotals[index])}점)`),
    "", "", "", "",
  );

  const rows = entriesInOrder.map((entry) => {
    const num = String(entry.num);
    const manual = score.manualScores?.[num] || {};
    const bonus = Number(manual.bonus || 0);
    const deduction = Number(manual.deduction || 0);
    const total = Number(scoreCache.totalScoreMap?.[num] || 0);
    const subtotal = round2(total - bonus + deduction);
    const energy = score.energy?.teams?.[num];
    const values = [entry.num, entry.univ || "", entry.team || "", entry.type || ""];
    const inspectionResults = inspectionTeams[num]?.results || {};

    for (const category of categories) {
      if ((category.excluded_types || []).includes(entry.type)) values.push("");
      else values.push(inspectionResults[category.id] === "FAIL" ? "O" : "");
    }

    values.push(
      ranks.get(entry.num) || "",
      total,
      Number(manual.report || 0),
      ...scoredEvents.map((eventType) => Number(scoreCache.eventScoreMap?.[eventType]?.[num] || 0)),
      energy?.status === "SCORED" ? Number(energy.score || 0) : 0,
      subtotal,
      deduction,
      bonus,
      "",
    );

    return { values, vehicleType: entry.type || "" };
  });

  const merges = ["A1:A2", "B1:B2", "C1:C2", "D1:D2"];
  if (categories.length > 1) merges.push(`E1:${columnName(inspectionEnd)}1`);
  merges.push(
    `${columnName(rankColumn)}1:${columnName(rankColumn)}2`,
    `${columnName(finalColumn)}1:${columnName(finalColumn)}2`,
    `${columnName(evaluationStart)}1:${columnName(evaluationEnd)}1`,
    `${columnName(subtotalColumn)}1:${columnName(subtotalColumn)}2`,
    `${columnName(deductionColumn)}1:${columnName(deductionColumn)}2`,
    `${columnName(bonusColumn)}1:${columnName(bonusColumn)}2`,
    `${columnName(reasonColumn)}1:${columnName(reasonColumn)}2`,
  );

  const widths = [8, 25, 29, 14];
  widths.push(...categories.map(() => 11));
  widths.push(9, 14, ...scoreColumns.map(() => 13), 13, 10, 10, 27);

  return {
    kind: "overall",
    name: "전체 점수표",
    headerRows: [firstHeader, secondHeader],
    merges,
    rows,
    widths,
    rankColumn,
    finalColumn,
    scoreStartColumn: finalColumn,
    scoreEndColumn: bonusColumn,
    deductionColumn,
    bonusColumn,
  };
}

function columnName(columnNumber) {
  let value = columnNumber;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export function buildOfficialScoreWorkbookModel({ score, endurance, scoreCache }) {
  return {
    fileBase: `성적표_${score.year || ""}`.replace(/_$/, ""),
    sheets: [
      ...OFFICIAL_EVENT_TYPES.map((eventType) => buildEventSheet(
        score.entries,
        score.events,
        score.penalties,
        eventType,
      )),
      buildEnduranceSheet(score.entries, endurance, score.penalties),
      buildStartingOrderSheet(score.entries, score.events, endurance),
      buildOverallSheet(score, scoreCache),
    ],
  };
}

const baseAlignment = Object.freeze({ horizontal: "center", vertical: "middle", wrapText: true });
const baseFont = Object.freeze({ name: "맑은 고딕", size: 10, bold: true, color: { argb: COLORS.text } });

function applyHeaderStyle(cell, yellow = false, bordered = false) {
  cell.font = {
    name: "맑은 고딕",
    size: 10,
    bold: true,
    color: { argb: yellow ? COLORS.text : COLORS.headerText },
  };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: yellow ? COLORS.yellow : COLORS.blue } };
  cell.alignment = baseAlignment;
  if (bordered) cell.border = fullBorder("thin");
}

function applyDataStyle(cell, vehicleType = "", bordered = false) {
  const color = vehicleType === "E-Formula"
    ? COLORS.electric
    : vehicleType === "C-Formula"
      ? COLORS.combustion
      : COLORS.text;
  cell.font = { ...baseFont, color: { argb: color } };
  cell.alignment = baseAlignment;
  if (bordered) cell.border = fullBorder("hair");
}

function fullBorder(style) {
  const side = { style, color: { argb: COLORS.border } };
  return { top: side, left: side, bottom: side, right: side };
}

function applyFill(cell, color) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function setColumns(worksheet, widths) {
  worksheet.columns = widths.map((width) => ({ width }));
}

function setPrintLayout(worksheet, { headerRows = 1, paperSize = 9, freezeColumns = 4 }) {
  worksheet.views = [{
    state: "frozen",
    xSplit: freezeColumns,
    ySplit: headerRows,
    topLeftCell: `${columnName(freezeColumns + 1)}${headerRows + 1}`,
    activeCell: `${columnName(freezeColumns + 1)}${headerRows + 1}`,
    showGridLines: true,
  }];
  worksheet.pageSetup = {
    orientation: "landscape",
    paperSize,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `1:${headerRows}`,
    printArea: `A1:${columnName(worksheet.columnCount)}${worksheet.rowCount}`,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  worksheet.pageSetup.showGridLines = true;
}

function populateEventSheet(worksheet, sheet) {
  worksheet.addRow(sheet.headers);
  for (const row of sheet.rows) worksheet.addRow(row.values);
  setColumns(worksheet, sheet.widths);
  worksheet.getRow(1).height = 33.95;
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    applyHeaderStyle(cell, column === sheet.bestColumn, true);
  });
  sheet.rows.forEach((row, index) => {
    const excelRow = worksheet.getRow(index + 2);
    excelRow.height = 23.1;
    excelRow.eachCell({ includeEmpty: true }, (cell, column) => {
      applyDataStyle(cell, column <= 4 ? row.vehicleType : "", true);
      if (index % 2 === 1) applyFill(cell, COLORS.alternateRow);
      if (column === sheet.rankColumn) applyFill(cell, COLORS.rank);
      if (column === sheet.bestColumn) applyFill(cell, COLORS.paleYellow);
    });
  });
  setPrintLayout(worksheet, { headerRows: 1, paperSize: 9, freezeColumns: 4 });
}

function populateEnduranceSheet(worksheet, sheet) {
  for (const row of sheet.headerRows) worksheet.addRow(row);
  for (const row of sheet.rows) worksheet.addRow(row.values);
  setColumns(worksheet, sheet.widths);
  for (const range of sheet.merges) worksheet.mergeCells(range);
  for (let row = 1; row <= 2; row++) {
    for (let column = 1; column <= sheet.widths.length; column++) {
      applyHeaderStyle(
        worksheet.getCell(row, column),
        column >= sheet.bestColumn && column <= sheet.bestColumn + 2,
        true,
      );
    }
  }
  worksheet.getRow(1).height = 26;
  worksheet.getRow(2).height = 58;
  sheet.rows.forEach((row, index) => {
    const excelRow = worksheet.getRow(index + 3);
    excelRow.height = 23.1;
    excelRow.eachCell({ includeEmpty: true }, (cell, column) => {
      applyDataStyle(cell, column <= 3 ? row.vehicleType : "", true);
      if (index % 2 === 1) applyFill(cell, COLORS.alternateRow);
      if (column === sheet.rankColumn) applyFill(cell, COLORS.rank);
      if (column === sheet.bestColumn) applyFill(cell, COLORS.paleYellow);
    });
  });
  setPrintLayout(worksheet, { headerRows: 2, paperSize: 8, freezeColumns: 3 });
}

function populateStartingOrderSheet(worksheet, sheet) {
  worksheet.addRow(sheet.headers);
  for (const row of sheet.rows) worksheet.addRow(row.values);
  setColumns(worksheet, sheet.widths);
  worksheet.getRow(1).height = 33.95;
  for (let column = 1; column <= sheet.widths.length; column++) {
    applyHeaderStyle(worksheet.getCell(1, column), false, true);
  }
  sheet.rows.forEach((row, index) => {
    const excelRow = worksheet.getRow(index + 2);
    excelRow.height = 26.1;
    excelRow.eachCell({ includeEmpty: true }, (cell, column) => {
      applyDataStyle(cell, column >= 3 && column <= 6 ? row.vehicleType : "", true);
      if (row.group === 1) {
        applyFill(cell, COLORS.groupOne);
      } else if (index % 2 === 1) {
        applyFill(cell, COLORS.alternateRow);
      }
    });
  });
  for (const range of sheet.groupRanges) {
    if (range.startRow !== range.endRow) worksheet.mergeCells(`A${range.startRow}:A${range.endRow}`);
  }
  setPrintLayout(worksheet, { headerRows: 1, paperSize: 9, freezeColumns: 2 });
}

function populateOverallSheet(worksheet, sheet) {
  for (const row of sheet.headerRows) worksheet.addRow(row);
  for (const row of sheet.rows) worksheet.addRow(row.values);
  setColumns(worksheet, sheet.widths);
  for (const range of sheet.merges) worksheet.mergeCells(range);
  for (let row = 1; row <= 2; row++) {
    for (let column = 1; column <= sheet.widths.length; column++) {
      applyHeaderStyle(worksheet.getCell(row, column), column === sheet.finalColumn, true);
    }
  }
  worksheet.getRow(1).height = 28;
  worksheet.getRow(2).height = 48;
  sheet.rows.forEach((row, index) => {
    const excelRow = worksheet.getRow(index + 3);
    excelRow.height = 23.1;
    excelRow.eachCell({ includeEmpty: true }, (cell, column) => {
      applyDataStyle(cell, column <= 4 ? row.vehicleType : "", true);
      if (index % 2 === 1) applyFill(cell, COLORS.alternateRow);
      if (column >= sheet.scoreStartColumn && column <= sheet.scoreEndColumn) {
        cell.numFmt = Number(cell.value) === 0 ? "0" : "0.00";
      }
      if (column === sheet.deductionColumn || column === sheet.bonusColumn) cell.numFmt = "0";
      if (column === sheet.rankColumn) applyFill(cell, COLORS.rank);
      if (column === sheet.finalColumn) {
        applyFill(cell, COLORS.paleYellow);
      }
    });
  });
  setPrintLayout(worksheet, { headerRows: 2, paperSize: 8, freezeColumns: 4 });
}

export async function createOfficialScoreWorkbook(model) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  // ExcelJS serializes falsy author fields as "Unknown". A single whitespace
  // character keeps the visible document properties blank after serialization.
  workbook.creator = " ";
  workbook.lastModifiedBy = " ";

  for (const sheet of model.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    if (sheet.kind === "event") populateEventSheet(worksheet, sheet);
    else if (sheet.kind === "endurance") populateEnduranceSheet(worksheet, sheet);
    else if (sheet.kind === "startingOrder") populateStartingOrderSheet(worksheet, sheet);
    else if (sheet.kind === "overall") populateOverallSheet(worksheet, sheet);
  }

  return workbook;
}

export async function downloadOfficialScoreWorkbook(model) {
  const workbook = await createOfficialScoreWorkbook(model);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${model.fileBase}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
