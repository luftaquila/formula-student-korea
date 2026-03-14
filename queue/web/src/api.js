import { createApiClient } from "@shared/api-base.js";

const { request, BASE_URL } = createApiClient("/queue");

export async function fetchEntries(year) {
  const qs = year != null ? `?year=${year}` : "";
  const res = await fetch(`${BASE_URL}/api/entries${qs}`);
  if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
  return res.json();
}

export async function fetchEntryYears() {
  const res = await fetch(`${BASE_URL}/api/years`);
  if (!res.ok) throw new Error("연도 정보를 가져올 수 없습니다.");
  return res.json();
}

/* ============================================
   Public API
   ============================================ */
export async function fetchActiveInspections() {
  const res = await request("/api/active");
  return res.json();
}

export async function fetchQueueState(num, phone) {
  const res = await request(`/api/state/${num}`, {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
  return res.json();
}

/* ============================================
   Public API - 부스 현황
   ============================================ */
export async function getPublicBooths(type) {
  const res = await request(`/api/booths/${type}`);
  return res.json();
}

export async function getAllPublicBooths() {
  const res = await request("/api/booths/all");
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

/* ============================================
   Admin API - 부스 관리
   ============================================ */
export async function getBooths(type) {
  const res = await request(`/api/admin/booths/${type}`);
  return res.json();
}

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
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.inspection) query.set("inspection", params.inspection);
  const qs = query.toString();
  const res = await request(`/api/admin/stats${qs ? `?${qs}` : ""}`);
  return res.json();
}

export async function getTeamStats(num, params = {}) {
  const query = new URLSearchParams();
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
  const res = await request("/api/settings/sms");
  return res.json();
}

export async function setSmsSettings(value) {
  await request("/api/admin/settings/sms", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export async function fetchSmsRankSettings() {
  const res = await request("/api/settings/sms-rank");
  return res.json();
}

export async function setSmsRankSettings(value) {
  await request("/api/admin/settings/sms-rank", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export async function fetchCancelPenaltySettings() {
  const res = await request("/api/settings/cancel-penalty");
  return res.json();
}

export async function setCancelPenaltySettings(value) {
  await request("/api/admin/settings/cancel-penalty", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}
