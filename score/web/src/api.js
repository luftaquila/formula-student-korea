import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntryYears } = createApiClient("/score");

export { fetchEntryYears };

/* ============================================
   Score API
   ============================================ */
export async function fetchScore(year) {
  const res = await request(`/api/score?year=${year}`);
  return res.json();
}

export async function fetchTeamRecords(year, event_type, team_num) {
  const res = await request(`/api/score/records?year=${year}&event_type=${encodeURIComponent(event_type)}&team_num=${team_num}`);
  return res.json();
}

export async function selectRecord(year, event_type, team_num, table_name, record_rowid, result, detail) {
  await request("/api/score/record", {
    method: "PUT",
    body: JSON.stringify({ year, event_type, team_num, table_name, record_rowid, result, detail }),
  });
}

export async function deselectRecord(year, event_type, team_num) {
  await request("/api/score/record", {
    method: "DELETE",
    body: JSON.stringify({ year, event_type, team_num }),
  });
}

export async function updateManualScore(year, team_num, score_type, value) {
  await request("/api/score/manual", {
    method: "PUT",
    body: JSON.stringify({ year, team_num, score_type, value }),
  });
}
