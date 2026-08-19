import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntryYears, fetchEntries, fetchVehicleTypes } = createApiClient("/competition/api/v1/score");

export { fetchEntryYears, fetchEntries, fetchVehicleTypes };

/* ============================================
   Score API
   ============================================ */
export async function fetchScore(year) {
  const res = await request(`/api/score?year=${year}`);
  return res.json();
}

export async function fetchScorePublication(year) {
  const res = await request(`/api/score/publication?year=${year}`);
  return res.json();
}

export async function updateScorePublication(year, enabled) {
  const res = await request("/api/score/publication", {
    method: "PUT",
    body: JSON.stringify({ year, enabled }),
  });
  return res.json();
}

export async function fetchPublicScore(year) {
  const res = await fetch(`/competition/api/v1/score/score/public/${year}`);
  if (!res.ok) {
    const requestError = new Error(await res.text() || `요청 실패 (${res.status})`);
    requestError.status = res.status;
    throw requestError;
  }
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
