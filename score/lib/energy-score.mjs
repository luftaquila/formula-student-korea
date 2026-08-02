const ELECTRIC_CO2_FACTOR = 1.3;
const MAX_CO2_PER_100KM = 60.06;
const MAX_LAP_TIME_RATIO = 1.45;

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function pending(reason) {
  return { status: "PENDING", reason, score: null };
}

function disqualified(reason) {
  return { status: "DSQ", reason, score: 0 };
}

/**
 * 경기진행규정 제12조에 따라 에너지 효율 점수를 계산한다.
 * enduranceRecords의 result에는 출발지연/수동 페널티가, cones/oc에는 아직 시간으로
 * 환산되지 않은 횟수가 들어온다는 score 집계 계약을 따른다.
 */
export function calculateEnergyScores({ rows, entries, enduranceRecords, endurancePenalty, settings }) {
  const total = Number(settings?.total);
  const distanceKm = Number(settings?.distance_km);
  const fuelFactor = Number(settings?.fuel_factor);
  const totalValid = Number.isFinite(total) && total > 0;
  const distanceValid = Number.isFinite(distanceKm) && distanceKm > 0;

  const adjustedTimes = {};
  // 내구 완주팀은 동일한 공식 랩 수를 주행하므로 평균 랩타임의 비율은
  // 페널티 반영 최종 기록의 비율과 같다: (Tmin / N) / (Tyours / N).
  for (const [num, record] of Object.entries(enduranceRecords || {})) {
    if (record?.result == null || record.result < 0) continue;
    adjustedTimes[num] = record.result
      + (record.cones || 0) * (endurancePenalty?.cone_penalty || 0) * 1000
      + (record.oc || 0) * (endurancePenalty?.oc_penalty || 0) * 1000;
  }
  const finishedTimes = Object.values(adjustedTimes).filter((value) => Number.isFinite(value) && value > 0);
  const fastestFinishedTime = finishedTimes.length ? Math.min(...finishedTimes) : null;

  const teams = {};
  const candidates = [];

  for (const row of rows || []) {
    const num = String(row.team_num);
    const vehicleType = entries?.[num]?.type;
    const energyType = vehicleType === "C-Formula" ? "C" : vehicleType === "E-Formula" ? "E" : null;
    const common = energyType ? { energyType } : {};

    let correctedCo2 = null;
    let measurementIssue = null;
    if (energyType === "C") {
      if (![2.31, 2.95].includes(fuelFactor)) {
        measurementIssue = "휘발유 계산 기준 설정 필요";
      } else if (row.fuel_consumed == null) {
        measurementIssue = "연료 소비량 입력 필요";
      } else {
        const fuelConsumed = Number(row.fuel_consumed);
        const fuelExtra = row.fuel_extra == null ? 0 : Number(row.fuel_extra);
        if (!Number.isFinite(fuelConsumed) || fuelConsumed < 0 || !Number.isFinite(fuelExtra) || fuelExtra < 0) {
          measurementIssue = "올바른 연료 소비량 입력 필요";
        } else {
          const correctedFuel = fuelConsumed + fuelExtra * 2;
          correctedCo2 = correctedFuel * fuelFactor;
          if (correctedFuel === 0) measurementIssue = "연료 소비량 0: 오피셜 판정 필요";
        }
      }
    } else if (energyType === "E") {
      if (row.electric_net_energy == null) {
        measurementIssue = "순사용 전력량 입력 필요";
      } else {
        const netEnergy = Number(row.electric_net_energy);
        if (!Number.isFinite(netEnergy)) {
          measurementIssue = "올바른 순사용 전력량 입력 필요";
        } else {
          correctedCo2 = netEnergy * ELECTRIC_CO2_FACTOR;
          if (netEnergy === 0) measurementIssue = "순사용 전력량 0: 오피셜 판정 필요";
        }
      }
    } else {
      measurementIssue = "차량 유형을 C-Formula 또는 E-Formula로 설정 필요";
    }

    let co2Per100Km = null;
    if (correctedCo2 != null) {
      common.correctedCo2 = round(correctedCo2, 6);
      if (distanceValid) {
        co2Per100Km = correctedCo2 / distanceKm * 100;
        common.co2Per100Km = round(co2Per100Km, 6);
      }
    }

    const enduranceStatus = row.status;
    if (["DNS", "DNF", "DSQ"].includes(enduranceStatus)) {
      teams[num] = { ...disqualified(`내구 ${enduranceStatus}`), ...common };
      continue;
    }
    if (row.energy_dsq) {
      teams[num] = { ...disqualified("오피셜 실격"), ...common };
      continue;
    }
    if (measurementIssue) {
      teams[num] = { ...pending(measurementIssue), ...common };
      continue;
    }
    if (!distanceValid) {
      teams[num] = { ...pending("내구 거리 설정 필요"), ...common };
      continue;
    }
    if (co2Per100Km > MAX_CO2_PER_100KM) {
      teams[num] = { ...disqualified("보정 소비량 60.06 kg CO₂/100km 초과"), ...common };
      continue;
    }
    const time = adjustedTimes[num];
    if (!Number.isFinite(time) || time <= 0 || fastestFinishedTime == null) {
      teams[num] = { ...pending("내구 완주 기록 필요"), ...common };
      continue;
    }
    if (time > fastestFinishedTime * MAX_LAP_TIME_RATIO) {
      teams[num] = { ...disqualified("평균 랩타임 145% 초과"), ...common };
      continue;
    }
    if (!totalValid) {
      teams[num] = { ...pending("에너지 총점 설정 필요"), ...common };
      continue;
    }
    if (correctedCo2 < 0) {
      teams[num] = { status: "SCORED", reason: "회생 충전량이 사용량 초과", score: round(total), ...common };
      continue;
    }

    const candidate = { num, time, correctedCo2, ...common };
    candidates.push(candidate);
    teams[num] = { status: "PENDING", reason: "상대점수 계산 중", score: null, ...common };
  }

  const eligibleTimes = [
    ...candidates.map((candidate) => candidate.time),
    ...Object.entries(teams)
      .filter(([, result]) => result.status === "SCORED" && result.correctedCo2 < 0)
      .map(([num]) => adjustedTimes[num])
      .filter((value) => Number.isFinite(value) && value > 0),
  ];
  const tMin = eligibleTimes.length ? Math.min(...eligibleTimes) : null;
  const co2Min = candidates.length ? Math.min(...candidates.map((candidate) => candidate.correctedCo2)) : null;

  const efValues = [];
  if (tMin != null && co2Min != null && co2Min > 0) {
    for (const candidate of candidates) {
      candidate.ef = (tMin / candidate.time) * (co2Min / candidate.correctedCo2);
      efValues.push(candidate.ef);
    }
  }
  const efMin = efValues.length ? Math.min(...efValues) : null;
  const efMax = efValues.length ? Math.max(...efValues) : null;

  for (const candidate of candidates) {
    if (candidate.ef == null || efMin == null || efMax == null) {
      teams[candidate.num] = { ...teams[candidate.num], ...pending("상대점수 기준팀 필요") };
      continue;
    }
    let score;
    if (Math.abs(efMax - efMin) <= Number.EPSILON) {
      // 유효 참가팀이 한 팀뿐이거나 EF가 완전히 같으면 규정식의 분모가 0이다.
      // 동일 성적을 다르게 처리하지 않도록 설정된 총점을 함께 부여한다.
      score = total;
    } else {
      score = total * (((efMin / candidate.ef) - 1) / ((efMin / efMax) - 1));
    }
    teams[candidate.num] = {
      ...teams[candidate.num],
      status: "SCORED",
      reason: null,
      ef: round(candidate.ef, 8),
      score: round(Math.max(0, Math.min(total, score))),
    };
  }

  return {
    config: {
      total: totalValid ? total : null,
      distanceKm: distanceValid ? distanceKm : null,
      fuelFactor: [2.31, 2.95].includes(fuelFactor) ? fuelFactor : null,
    },
    references: {
      efMin: efMin == null ? null : round(efMin, 8),
      efMax: efMax == null ? null : round(efMax, 8),
    },
    teams,
  };
}
