import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntries, fetchEntryYears } = createApiClient("/competition/api/v1/queue");

export { fetchEntries, fetchEntryYears };

export async function fetchQueueState(num, phone) {
  const res = await request(`/api/state/${num}`, {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
  return res.json();
}

/* ============================================
   Admin API - 검차 관리
   ============================================ */
export async function fetchAllInspections() {
  const res = await request("/api/admin/all");
  return res.json();
}

export async function fetchInspectionQueue(type) {
  const res = await request(`/api/admin/inspection/${type}`);
  return res.json();
}

export async function toggleInspectionActive(type, active) {
  await request(`/api/admin/inspection/${type}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
}

export async function toggleInspectionVisibility(type, hidden) {
  await request(`/api/admin/inspection/${type}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ hidden }),
  });
}

/* ============================================
   Admin API - 대기열 등록/입장/취소
   ============================================ */
export async function registerToQueue(type, num, phone) {
  await request(`/api/admin/register/${type}`, {
    method: "POST",
    body: JSON.stringify({ num, phone }),
  });
}

export async function cancelFromQueue(type, num) {
  await request(`/api/admin/cancel/${type}`, {
    method: "POST",
    body: JSON.stringify({ num }),
  });
}

export async function fetchActivePenalties() {
  const res = await request("/api/admin/penalties");
  return res.json();
}

export async function clearActivePenalty(type, num) {
  await request(`/api/admin/penalties/${type}/${num}`, {
    method: "DELETE",
  });
}

export async function restoreActivePenalty(type, num) {
  await request(`/api/admin/penalties/${type}/${num}/restore`, {
    method: "POST",
  });
}

/* ============================================
   Admin API - 부스 관리
   ============================================ */
export async function updateBoothConfig(type, count) {
  await request(`/api/admin/booths/${type}/config`, {
    method: "PATCH",
    body: JSON.stringify({ count }),
  });
}

export async function toggleBooth(type, boothNum, active) {
  await request(`/api/admin/booths/${type}/${boothNum}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
}

export async function enterBooth(type, boothNum, num) {
  await request(`/api/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    body: JSON.stringify({ num }),
  });
}

export async function exitBooth(type, boothNum) {
  await request(`/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
  });
}

/* ============================================
   Admin API - 팀 우선순위 관리
   ============================================ */
export async function fetchPriorities(type) {
  const res = await request(`/api/admin/priority/${type}`);
  return res.json();
}

export async function setPriority(type, num, priority) {
  await request(`/api/admin/priority/${type}`, {
    method: "POST",
    body: JSON.stringify({ num, priority }),
  });
}

export async function removePriority(type, num) {
  await request(`/api/admin/priority/${type}`, {
    method: "DELETE",
    body: JSON.stringify({ num }),
  });
}

export async function resetAllPriorities(type) {
  await request(`/api/admin/priority/${type}/all`, {
    method: "DELETE",
  });
}

/* ============================================
   Admin API - 검차 이력 초기화
   ============================================ */
export async function fetchReinspectionStatus() {
  const res = await request("/api/admin/history/status");
  return res.json();
}

export async function resetInspectionHistory(type) {
  await request(`/api/admin/history/${type}`, {
    method: "DELETE",
  });
}

export async function setInspectionIgnore(type, field, value) {
  await request(`/api/admin/inspection/${type}/ignore`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  });
}

/* ============================================
   Admin API - 통계
   ============================================ */
export async function getStatsTimerange(year) {
  const qs = year != null ? `?year=${year}` : "";
  const res = await request(`/api/admin/stats/timerange${qs}`);
  return res.json();
}

export async function getStats(params = {}) {
  const query = new URLSearchParams();
  if (params.year) query.set("year", params.year);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.inspection) query.set("inspection", params.inspection);
  const qs = query.toString();
  const res = await request(`/api/admin/stats${qs ? `?${qs}` : ""}`);
  return res.json();
}

export async function getTeamStats(num, params = {}) {
  const query = new URLSearchParams();
  if (params.year) query.set("year", params.year);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.inspection) query.set("inspection", params.inspection);
  const qs = query.toString();
  const res = await request(`/api/admin/stats/${num}${qs ? `?${qs}` : ""}`);
  return res.json();
}

/* ============================================
   Settings API
   ============================================ */
export async function fetchSmsSettings() {
  const res = await request("/api/admin/settings/sms");
  return res.json();
}

export async function setSmsSettings(value) {
  await request("/api/admin/settings/sms", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export async function fetchSmsRankSettings() {
  const res = await request("/api/admin/settings/sms-rank");
  return res.json();
}

export async function setSmsRankSettings(value) {
  await request("/api/admin/settings/sms-rank", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export async function fetchCancelPenaltySettings() {
  const res = await request("/api/admin/settings/cancel-penalty");
  return res.json();
}

export async function setCancelPenaltySettings(value) {
  await request("/api/admin/settings/cancel-penalty", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}
