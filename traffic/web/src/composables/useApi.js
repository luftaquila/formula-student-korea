const BASE_URL = import.meta.env.PROD ? "/traffic" : "";

/**
 * 공통 fetch 래퍼
 * @param {string} endpoint - API 엔드포인트
 * @param {RequestInit} options - fetch 옵션
 * @returns {Promise<Response>}
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
   Entry API (/entry 서비스 직접 호출)
   ============================================ */
const ENTRY_URL = import.meta.env.PROD ? "/entry" : "/entry";

export async function fetchEntries() {
  const res = await fetch(`${ENTRY_URL}/api/entries`);
  if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
  return res.json();
}

export async function fetchEntry(num) {
  const res = await fetch(`${ENTRY_URL}/api/entries/${num}`);
  if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
  return res.json();
}

export async function addEntry({ num, univ, team }) {
  const res = await fetch(`${ENTRY_URL}/api/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num, univ, team }),
  });
  if (!res.ok) throw new Error(await res.text() || `요청 실패 (${res.status})`);
}

export async function deleteEntry(num) {
  const res = await fetch(`${ENTRY_URL}/api/entries/${num}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text() || `요청 실패 (${res.status})`);
}

/* ============================================
   Record API
   ============================================ */

/**
 * 모든 기록 테이블 목록 조회
 */
export async function fetchRecords() {
  const res = await request("/api/records");
  return res.json();
}

/**
 * 특정 기록 조회
 */
export async function fetchRecord(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}`);
  return res.json();
}

/**
 * 새 기록 추가
 */
export async function addRecord(name, data) {
  await request("/api/records", {
    method: "POST",
    body: JSON.stringify({ name, data }),
  });
}

/**
 * 기록 테이블 삭제
 */
export async function deleteRecord(name) {
  await request(`/api/records/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

/**
 * 기록 필드 업데이트 (invalidated, scoreboard, note)
 */
export async function updateRecord(name, rowid, field, value) {
  const res = await request(`/api/records/${encodeURIComponent(name)}/${rowid}`, {
    method: "PATCH",
    body: JSON.stringify({ field, value }),
  });
  return res.json();
}

/* ============================================
   Controller API
   ============================================ */

/**
 * 모든 컨트롤러 로그 조회
 */
export async function fetchControllers() {
  const res = await request("/api/controllers");
  return res.json();
}

/**
 * 컨트롤러 로그 추가
 */
export async function addControllerLog(timestamp, data) {
  await request("/api/controllers", {
    method: "POST",
    body: JSON.stringify({ timestamp, data }),
  });
}

/**
 * 모든 컨트롤러 로그 삭제
 */
export async function deleteControllers() {
  await request("/api/controllers", {
    method: "DELETE",
  });
}
