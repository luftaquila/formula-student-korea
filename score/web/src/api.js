import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntryYears, fetchEntries, fetchVehicleTypes } = createApiClient("/score");

export { fetchEntryYears, fetchEntries, fetchVehicleTypes };

/* ============================================
   Score API
   ============================================ */
export async function fetchScore(year) {
  const res = await request(`/api/score?year=${year}`);
  return res.json();
}

export async function updateManualScore(year, team_num, score_type, value) {
  await request("/api/score/manual", {
    method: "PUT",
    body: JSON.stringify({ year, team_num, score_type, value }),
  });
}

export async function updatePenalty(year, event_type, cone_penalty, oc_penalty, start_delay) {
  await request("/api/score/penalty", {
    method: "PUT",
    body: JSON.stringify({ year, event_type, cone_penalty, oc_penalty, start_delay }),
  });
}

export async function updateSetting(year, event_type, setting_key, value) {
  await request("/api/score/setting", {
    method: "PUT",
    body: JSON.stringify({ year, event_type, setting_key, value }),
  });
}

export async function fetchEndurance(year) {
  const res = await request(`/api/score/endurance?year=${year}`);
  return res.json();
}

export async function updateEndurance(year, team_num, field, value) {
  await request("/api/score/endurance", {
    method: "PUT",
    body: JSON.stringify({ year, team_num, field, value }),
  });
}
