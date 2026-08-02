import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateEnergyScores } from "../../score/lib/energy-score.mjs";

const settings = { total: 40, distance_km: 20, fuel_factor: 2.31 };
const endurancePenalty = { cone_penalty: 2, oc_penalty: 10 };

function calculate(rows, records, overrides = {}, entryTypes = {}) {
  return calculateEnergyScores({
    rows,
    entries: Object.fromEntries(rows.map((row) => [
      String(row.team_num),
      { type: entryTypes[row.team_num] || "C-Formula" },
    ])),
    enduranceRecords: records,
    endurancePenalty,
    settings: { ...settings, ...overrides },
  });
}

describe("energy efficiency score calculation", () => {
  it("derives C/E from vehicle types and ranks mixed positive consumers", () => {
    const result = calculate([
      { team_num: 1, fuel_consumed: 1, fuel_extra: 0 },
      { team_num: 2, electric_net_energy: 2 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 110_000, cones: 0, oc: 0 },
    }, {}, { 2: "E-Formula" });

    assert.equal(result.teams[1].status, "SCORED");
    assert.equal(result.teams[1].energyType, "C");
    assert.equal(result.teams[1].score, 40);
    assert.equal(result.teams[2].status, "SCORED");
    assert.equal(result.teams[2].energyType, "E");
    assert.equal(result.teams[2].score, 0);
  });

  it("doubles additional C-Formula fuel before CO2 conversion", () => {
    const result = calculate([
      { team_num: 1, fuel_consumed: 1, fuel_extra: 0.5 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].correctedCo2, 4.62);
    assert.equal(result.teams[1].score, 40);
  });

  it("accepts additional fuel as the measured amount when the initial amount is zero", () => {
    const result = calculate([
      { team_num: 1, fuel_consumed: 0, fuel_extra: 0.5 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "SCORED");
    assert.equal(result.teams[1].correctedCo2, 2.31);
  });

  it("awards configured maximum for a negative net electric measurement", () => {
    const result = calculate([
      { team_num: 1, electric_net_energy: -0.25 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    }, {}, { 1: "E-Formula" });

    assert.equal(result.teams[1].status, "SCORED");
    assert.equal(result.teams[1].score, 40);
    assert.match(result.teams[1].reason, /회생/);
  });

  it("leaves an exact zero net electric measurement for official review", () => {
    const result = calculate([
      { team_num: 1, electric_net_energy: 0 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    }, {}, { 1: "E-Formula" });

    assert.equal(result.teams[1].status, "PENDING");
    assert.match(result.teams[1].reason, /오피셜 판정/);
    assert.equal(result.teams[1].correctedCo2, 0);
    assert.equal(result.teams[1].co2Per100Km, 0);
  });

  it("disqualifies endurance non-finishers and official energy DSQ", () => {
    const result = calculate([
      { team_num: 1, status: "DNF", fuel_consumed: 1 },
      { team_num: 2, energy_dsq: 1, fuel_consumed: 1 },
    ], {
      2: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "DSQ");
    assert.equal(result.teams[1].reason, "내구 DNF");
    assert.equal(result.teams[1].score, 0);
    assert.equal(result.teams[1].co2Per100Km, 11.55);
    assert.equal(result.teams[2].status, "DSQ");
    assert.equal(result.teams[2].reason, "오피셜 실격");
    assert.equal(result.teams[2].score, 0);
    assert.equal(result.teams[2].co2Per100Km, 11.55);
  });

  it("selects Tmin and CO2min only from non-disqualified efficiency teams", () => {
    const result = calculate([
      { team_num: 1, energy_dsq: 1, fuel_consumed: 0.5 },
      { team_num: 2, fuel_consumed: 1 },
      { team_num: 3, fuel_consumed: 1.2 },
    ], {
      1: { result: 80_000, cones: 0, oc: 0 },
      2: { result: 100_000, cones: 0, oc: 0 },
      3: { result: 110_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "DSQ");
    assert.equal(result.teams[2].status, "SCORED");
    assert.equal(result.teams[2].ef, 1);
    assert.equal(result.teams[3].status, "SCORED");
    assert.equal(result.teams[3].ef, 0.75757576);
  });

  it("applies the strict 145% lap-time disqualification after penalties", () => {
    const result = calculate([
      { team_num: 1, fuel_consumed: 1 },
      { team_num: 2, fuel_consumed: 1 },
      { team_num: 3, fuel_consumed: 1 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 145_000, cones: 0, oc: 0 },
      3: { result: 124_000, cones: 1, oc: 1 }, // 124s + 2s + 10s = 136s
    });

    assert.notEqual(result.teams[2].status, "DSQ", "exactly 145% remains eligible");
    assert.notEqual(result.teams[3].status, "DSQ", "adjusted 136% remains eligible");

    const over = calculate([
      { team_num: 1, fuel_consumed: 1 },
      { team_num: 2, fuel_consumed: 1 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 145_001, cones: 0, oc: 0 },
    });
    assert.equal(over.teams[2].status, "DSQ");
    assert.match(over.teams[2].reason, /145%/);
  });

  it("applies the strict 60.06 kg CO2/100km disqualification", () => {
    const exactFuel = 60.06 * 20 / 100 / 2.31;
    const result = calculate([
      { team_num: 1, fuel_consumed: exactFuel },
      { team_num: 2, fuel_consumed: exactFuel + 0.00000001 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.notEqual(result.teams[1].status, "DSQ");
    assert.equal(result.teams[2].status, "DSQ");
    assert.match(result.teams[2].reason, /60.06/);
  });

  it("exposes corrected consumption before score prerequisites are complete", () => {
    const missingConfig = calculate([
      { team_num: 1, fuel_consumed: 1 },
    ], {}, { total: null });
    assert.equal(missingConfig.teams[1].status, "PENDING");
    assert.equal(missingConfig.teams[1].correctedCo2, 2.31);
    assert.equal(missingConfig.teams[1].co2Per100Km, 11.55);
    assert.equal(missingConfig.config.distanceKm, 20);
    assert.equal(missingConfig.config.total, null);

    const missingDistance = calculate([
      { team_num: 1, fuel_consumed: 1 },
    ], {}, { distance_km: null });
    assert.equal(missingDistance.teams[1].correctedCo2, 2.31);
    assert.equal(missingDistance.teams[1].co2Per100Km, undefined);
  });

  it("keeps incomplete measurements pending, not disqualified", () => {
    const missingMeasurement = calculate([
      { team_num: 1, electric_net_energy: null },
    ], { 1: { result: 100_000, cones: 0, oc: 0 } }, {}, { 1: "E-Formula" });
    assert.equal(missingMeasurement.teams[1].status, "PENDING");
  });

  it("ignores legacy manual energy type and requires a Formula vehicle type", () => {
    const legacyConflict = calculate([
      { team_num: 1, energy_type: "E", fuel_consumed: 1, electric_net_energy: 9 },
    ], { 1: { result: 100_000, cones: 0, oc: 0 } });
    assert.equal(legacyConflict.teams[1].energyType, "C");
    assert.equal(legacyConflict.teams[1].correctedCo2, 2.31);

    const unknownType = calculate([
      { team_num: 1, fuel_consumed: 1 },
    ], { 1: { result: 100_000, cones: 0, oc: 0 } }, {}, { 1: "EV" });
    assert.equal(unknownType.teams[1].status, "PENDING");
    assert.match(unknownType.teams[1].reason, /차량 유형/);
  });
});
