const BASE_URL = import.meta.env.PROD ? "/queue" : "";
const ENTRY_URL = import.meta.env.PROD ? "/entry" : "/entry";

/**
 * 공통 fetch 래퍼
 */
async function request(endpoint, options = {}) {
  const config = {
    headers: { "Content-Type": "application/json" },
    ...options,
  };

  const res = await fetch(`${BASE_URL}${endpoint}`, config);

  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || `요청 실패 (${res.status})`);
  }

  return res;
}

/* ============================================
   Entry API (외부 서비스)
   ============================================ */
export async function fetchEntries() {
  const res = await fetch(`${ENTRY_URL}/api/entries`);
  if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
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
  const res = await request(`/api/state/${num}?phone=${phone}`);
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

/* ============================================
   Admin API - 대기열 등록/입장/취소
   ============================================ */
export async function registerToQueue(type, num, phone) {
  await request(`/api/admin/register/${type}`, {
    method: "POST",
    body: JSON.stringify({ num, phone }),
  });
}

export async function enterFromQueue(type, num) {
  await request(`/api/admin/enter/${type}`, {
    method: "POST",
    body: JSON.stringify({ num }),
  });
}

export async function cancelFromQueue(type, num) {
  await request(`/api/admin/cancel/${type}`, {
    method: "POST",
    body: JSON.stringify({ num }),
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
