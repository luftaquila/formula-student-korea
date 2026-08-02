import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateEnergyScores } from "../../score/lib/energy-score.mjs";

const settings = { total: 40, distance_km: 20, lap_count: 10, fuel_factor: 2.31 };
const endurancePenalty = { cone_penalty: 2, oc_penalty: 10 };

function calculate(rows, records, overrides = {}) {
  return calculateEnergyScores({
    rows,
    enduranceRecords: records,
    endurancePenalty,
    settings: { ...settings, ...overrides },
  });
}

describe("energy efficiency score calculation", () => {
  it("uses the configured total and ranks mixed C/E positive consumers", () => {
    const result = calculate([
      { team_num: 1, energy_type: "C", fuel_consumed: 1, fuel_extra: 0 },
      { team_num: 2, energy_type: "E", electric_net_energy: 2 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 110_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "SCORED");
    assert.equal(result.teams[1].score, 40);
    assert.equal(result.teams[2].status, "SCORED");
    assert.equal(result.teams[2].score, 0);
  });

  it("doubles additional C-Formula fuel before CO2 conversion", () => {
    const result = calculate([
      { team_num: 1, energy_type: "C", fuel_consumed: 1, fuel_extra: 0.5 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].correctedCo2, 4.62);
    assert.equal(result.teams[1].score, 40);
  });

  it("awards configured maximum for a negative net electric measurement", () => {
    const result = calculate([
      { team_num: 1, energy_type: "E", electric_net_energy: -0.25 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "SCORED");
    assert.equal(result.teams[1].score, 40);
    assert.match(result.teams[1].reason, /회생/);
  });

  it("leaves an exact zero net electric measurement for official review", () => {
    const result = calculate([
      { team_num: 1, energy_type: "E", electric_net_energy: 0 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.equal(result.teams[1].status, "PENDING");
    assert.match(result.teams[1].reason, /오피셜 판정/);
  });

  it("disqualifies endurance non-finishers and official energy DSQ", () => {
    const result = calculate([
      { team_num: 1, status: "DNF", energy_type: "C", fuel_consumed: 1 },
      { team_num: 2, energy_dsq: 1, energy_dsq_reason: "봉인 훼손", energy_type: "C", fuel_consumed: 1 },
    ], {
      2: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.deepEqual(result.teams[1], { status: "DSQ", reason: "내구 DNF", score: 0 });
    assert.deepEqual(result.teams[2], { status: "DSQ", reason: "봉인 훼손", score: 0 });
  });

  it("applies the strict 145% lap-time disqualification after penalties", () => {
    const result = calculate([
      { team_num: 1, energy_type: "C", fuel_consumed: 1 },
      { team_num: 2, energy_type: "C", fuel_consumed: 1 },
      { team_num: 3, energy_type: "C", fuel_consumed: 1 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 145_000, cones: 0, oc: 0 },
      3: { result: 124_000, cones: 1, oc: 1 }, // 124s + 2s + 10s = 136s
    });

    assert.notEqual(result.teams[2].status, "DSQ", "exactly 145% remains eligible");
    assert.notEqual(result.teams[3].status, "DSQ", "adjusted 136% remains eligible");

    const over = calculate([
      { team_num: 1, energy_type: "C", fuel_consumed: 1 },
      { team_num: 2, energy_type: "C", fuel_consumed: 1 },
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
      { team_num: 1, energy_type: "C", fuel_consumed: exactFuel },
      { team_num: 2, energy_type: "C", fuel_consumed: exactFuel + 0.0001 },
    ], {
      1: { result: 100_000, cones: 0, oc: 0 },
      2: { result: 100_000, cones: 0, oc: 0 },
    });

    assert.notEqual(result.teams[1].status, "DSQ");
    assert.equal(result.teams[2].status, "DSQ");
    assert.match(result.teams[2].reason, /60.06/);
  });

  it("keeps incomplete configuration and measurements pending, not disqualified", () => {
    const missingConfig = calculate([
      { team_num: 1, energy_type: "C", fuel_consumed: 1 },
    ], { 1: { result: 100_000, cones: 0, oc: 0 } }, { total: null });
    assert.equal(missingConfig.teams[1].status, "PENDING");

    const missingMeasurement = calculate([
      { team_num: 1, energy_type: "E", electric_net_energy: null },
    ], { 1: { result: 100_000, cones: 0, oc: 0 } });
    assert.equal(missingMeasurement.teams[1].status, "PENDING");
  });
});
