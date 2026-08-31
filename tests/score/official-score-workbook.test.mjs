import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOfficialScoreWorkbookModel,
  createOfficialScoreWorkbook,
  formatOfficialResult,
} from "../../score/web/src/lib/officialScoreWorkbook.js";

function fixture() {
  const entries = {
    1: { univ: "전기대학교", team: "Electric", type: "E-Formula" },
    2: { univ: "내연대학교", team: "Combustion", type: "C-Formula" },
    3: { univ: "미출전대학교", team: "DNS", type: "C-Formula" },
  };
  for (let num = 4; num <= 8; num++) {
    entries[num] = { univ: `대학 ${num}`, team: `Team ${num}`, type: "C-Formula" };
  }
  const accelerationRun = { time: "2026-08-29T06:00:00.000Z", result: 4_500, status: null, cones: 0, oc: 0 };
  const skidpadRun = { time: "2026-08-29T06:10:00.000Z", result: 30_000, status: null, cones: 4, oc: 0 };
  const autocrossRawBest = { time: "2026-08-29T06:20:00.000Z", result: 60_000, status: null, cones: 2, oc: 0 };
  const autocrossAdjustedBest = { time: "2026-08-29T06:21:00.000Z", result: 61_000, status: null, cones: 0, oc: 0 };
  const autocrossLeader = { time: "2026-08-29T06:22:00.000Z", result: 59_000, status: null, cones: 0, oc: 0 };
  const score = {
    year: 2026,
    entries,
    inspection: {
      categories: [
        { id: 9, name: "코너웨이트", excluded_types: [] },
        { id: 10, name: "제동", excluded_types: [] },
      ],
      cornerWeight: { categoryId: 9, items: {}, teams: {} },
      teams: { 1: { results: { 9: "FAIL", 10: "FAIL" } } },
    },
    events: [
      { type: "가속", records: { 1: { ...accelerationRun, allRuns: [accelerationRun] } } },
      { type: "스키드패드", records: { 1: { ...skidpadRun, allRuns: [skidpadRun] } } },
      {
        type: "오토크로스",
        records: {
          1: { ...autocrossAdjustedBest, allRuns: [autocrossRawBest, autocrossAdjustedBest] },
          2: { ...autocrossLeader, allRuns: [autocrossLeader] },
        },
      },
      { type: "내구", records: {} },
    ],
    manualScores: { 1: { report: 10, bonus: 5, deduction: 2 } },
    penalties: {
      가속: { cone_penalty: 0, oc_penalty: 0 },
      스키드패드: { cone_penalty: 0.3, oc_penalty: 20 },
      오토크로스: { cone_penalty: 2, oc_penalty: 20 },
      내구: { cone_penalty: 2, oc_penalty: 20, start_delay: 120 },
    },
    settings: {
      보고서: { total: 200 },
      가속: { total: 100 },
      스키드패드: { total: 100 },
      오토크로스: { total: 200 },
      내구: { total: 350 },
      에너지: { total: 50 },
    },
    energy: { teams: { 1: { status: "SCORED", score: 4 } } },
  };
  const endurance = {
    1: {
      qualified: 1,
      status: null,
      driver1_time: 2_100_000,
      driver1_start_delay: 0,
      driver1_cones: 0,
      driver1_oc: 0,
      driver1_penalty: 0,
      driver_change_time: null,
      driver2_time: 2_100_000,
      driver2_start_delay: 0,
      driver2_cones: 0,
      driver2_oc: 0,
      driver2_penalty: 0,
    },
    2: { qualified: 1, status: "DNF" },
    3: { qualified: 1, status: null },
  };
  for (let num = 4; num <= 8; num++) endurance[num] = { qualified: 1, status: null };
  const scoreCache = {
    eventScoreMap: {
      가속: { 1: 5 },
      스키드패드: { 1: 6 },
      오토크로스: { 1: 7 },
      내구: { 1: 8 },
    },
    totalScoreMap: { 1: 43, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },
  };
  return { score, endurance, scoreCache };
}

describe("official score workbook", () => {
  it("builds the six data-only sheets with regulated result formatting", () => {
    const model = buildOfficialScoreWorkbookModel(fixture());
    assert.equal(model.fileBase, "성적표_2026");
    assert.deepEqual(model.sheets.map((sheet) => sheet.name), [
      "가속",
      "스키드패드",
      "오토크로스",
      "내구",
      "스타팅오더",
      "전체 점수표",
    ]);
    assert.equal(formatOfficialResult(70 * 60_000), "70:00.000");

    const skidpad = model.sheets.find((sheet) => sheet.name === "스키드패드");
    assert.deepEqual(skidpad.rows[0].values.slice(4, 10), [
      1,
      "00:16.200",
      "00:15.000",
      4,
      0,
      "00:16.200",
    ]);

    const endurance = model.sheets.find((sheet) => sheet.name === "내구");
    const acceleration = model.sheets.find((sheet) => sheet.name === "가속");
    assert.deepEqual(acceleration.headers.slice(4), ["순위", "최고 기록", "기록 1", "기록 2", "기록 3", "기록 4"]);
    assert.equal(acceleration.rows[0].values[4], 1);
    assert.equal(acceleration.rows[1].values[4], "");
    assert.equal(endurance.headerRows[0][3], "순위");
    assert.equal(endurance.headerRows[0][4], "최종 기록");
    assert.equal(endurance.headerRows[1][7], "기록");
    assert.equal(endurance.headerRows.flat().some((value) => String(value).includes("(횟수)")), false);
    assert.equal(endurance.headerRows.flat().some((value) => String(value).includes("00:00.000")), false);
    assert.equal(endurance.rows[0].values[3], 1);
    assert.equal(endurance.rows[0].values[4], "70:00.000");
    assert.equal(endurance.rows[0].values[5], "70:00.000");
    assert.equal(endurance.rows[1].values[3], "");

    const autocross = model.sheets.find((sheet) => sheet.name === "오토크로스");
    assert.equal(autocross.rows[0].values[4], 2);
    assert.equal(autocross.rows[1].values[4], 1);

    const startingOrder = model.sheets.find((sheet) => sheet.name === "스타팅오더");
    assert.deepEqual(startingOrder.rows.slice(0, 3).map((row) => row.values[2]), [2, 1, 3]);
    assert.equal(startingOrder.rows[1].values[6], "01:00.000");
    assert.equal(startingOrder.rows[2].values[6], "DNS");
    assert.equal(startingOrder.headers.length, 7);
    assert.ok(startingOrder.rows.every((row) => row.values.length === 7));
    assert.deepEqual(startingOrder.rows[7].values.slice(0, 2), ["2그룹", 1]);
    assert.deepEqual(startingOrder.groupRanges, [
      { group: 1, startRow: 2, endRow: 8 },
      { group: 2, startRow: 9, endRow: 9 },
    ]);

    const overall = model.sheets.find((sheet) => sheet.name === "전체 점수표");
    assert.equal(overall.rows[0].values[4], "O");
    assert.equal(overall.headerRows[1][4], "제동");
    assert.equal(overall.headerRows.flat().includes("코너웨이트"), false);
    assert.equal(overall.headerRows[0][5], "순위");
    assert.equal(overall.headerRows[0][6], "최종 점수\n(①-②+③)");
    assert.equal(overall.rows[0].values[5], 1);
    assert.equal(overall.rows[1].values[5], 2);
    assert.equal(overall.rows[0].values[6], 43);
    assert.equal(overall.rows[0].values[13], 40);
    assert.equal(overall.rows[0].values.at(-1), "");
  });

  it("writes only styled data sheets without generated titles or metadata sheets", async () => {
    const model = buildOfficialScoreWorkbookModel(fixture());
    const workbook = await createOfficialScoreWorkbook(model);

    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), model.sheets.map((sheet) => sheet.name));
    assert.equal(workbook.creator.trim(), "");
    assert.equal(workbook.lastModifiedBy.trim(), "");
    assert.equal(workbook.getWorksheet("생성 정보"), undefined);
    assert.equal(workbook.getWorksheet("산출 기준"), undefined);
    assert.equal(workbook.getWorksheet("가속").getCell("A1").value, "번호");
    assert.equal(workbook.getWorksheet("스타팅오더").getCell("A1").value, "그룹");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("A1").value, "엔트리");
    assert.equal(workbook.getWorksheet("가속").getCell("A1").fill.fgColor.argb, "2F75B5");
    assert.equal(workbook.getWorksheet("가속").getCell("E2").fill.fgColor.argb, "E2F0D9");
    assert.equal(workbook.getWorksheet("가속").getCell("F2").fill.fgColor.argb, "FFF2CC");
    assert.equal(workbook.getWorksheet("가속").getCell("A3").fill.fgColor.argb, "F2F7FC");
    assert.equal(workbook.getWorksheet("가속").getCell("A2").border.bottom.style, "hair");
    assert.equal(workbook.getWorksheet("가속").views[0].xSplit, 4);
    assert.equal(workbook.getWorksheet("내구").getCell("D1").fill.fgColor.argb, "2F75B5");
    assert.equal(workbook.getWorksheet("내구").getCell("E1").fill.fgColor.argb, "FFFF00");
    assert.equal(workbook.getWorksheet("내구").getCell("D3").fill.fgColor.argb, "E2F0D9");
    assert.equal(workbook.getWorksheet("내구").getCell("E3").fill.fgColor.argb, "FFF2CC");
    assert.equal(workbook.getWorksheet("내구").views[0].xSplit, 3);
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("F3").fill.fgColor.argb, "E2F0D9");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("G3").fill.fgColor.argb, "FFF2CC");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("A4").fill.fgColor.argb, "F2F7FC");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("A3").border.bottom.style, "hair");
    assert.equal(workbook.getWorksheet("전체 점수표").views[0].xSplit, 4);
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("G3").numFmt, "0.00");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("G4").numFmt, "0");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("H4").numFmt, "0");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("O3").numFmt, "0");
    assert.equal(workbook.getWorksheet("전체 점수표").getCell("P3").numFmt, "0");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((row) => row.eachCell((cell) => {
        assert.equal(Boolean(cell.value && typeof cell.value === "object" && "formula" in cell.value), false);
      }));
    }

    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.byteLength > 0);
    const reloaded = await createOfficialScoreWorkbook({ sheets: [] });
    await reloaded.xlsx.load(buffer);
    assert.equal(reloaded.creator.trim(), "");
    assert.equal(reloaded.lastModifiedBy.trim(), "");
  });
});
