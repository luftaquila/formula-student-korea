const BASE_URL = import.meta.env.PROD ? "/entry" : "";

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

function yearParam(year, prefix = "?") {
  return year != null ? `${prefix}year=${year}` : "";
}

/**
 * 사용 가능한 연도 목록 조회
 */
export async function fetchYears() {
  const res = await request("/api/years");
  return res.json();
}

/**
 * 모든 엔트리 목록 조회
 */
export async function fetchEntries(year) {
  const res = await request(`/api/entries${yearParam(year)}`);
  return res.json();
}

/**
 * 엔트리 추가
 */
export async function addEntry({ num, univ, team, type }, year) {
  await request(`/api/entries${yearParam(year)}`, {
    method: "POST",
    body: JSON.stringify({ num, univ, team, type }),
  });
}

/**
 * 엔트리 수정
 */
export async function updateEntry({ num, univ, team, type, prev }, year) {
  await request(`/api/entries/${prev}${yearParam(year)}`, {
    method: "PATCH",
    body: JSON.stringify({ num, univ, team, type }),
  });
}

/**
 * 엔트리 삭제
 */
export async function deleteEntry(num, year) {
  await request(`/api/entries/${num}${yearParam(year)}`, {
    method: "DELETE",
  });
}

/**
 * 모든 엔트리 삭제
 */
export async function deleteAllEntries(year) {
  await request(`/api/entries${yearParam(year)}`, {
    method: "DELETE",
  });
}

/**
 * JSON 파일로 엔트리 일괄 업로드
 */
export async function uploadEntries(data, year) {
  await request(`/api/entries/bulk${yearParam(year)}`, {
    method: "POST",
    body: JSON.stringify({ data }),
  });
}

/**
 * 엔트리 JSON 다운로드 URL
 */
export function getDownloadUrl(year) {
  return `${BASE_URL}/api/entries?download${year != null ? `&year=${year}` : ""}`;
}

/**
 * 차량 유형 목록 조회
 */
export async function fetchVehicleTypes() {
  const res = await request("/api/vehicle-types");
  return res.json();
}

/**
 * 차량 유형 추가
 */
export async function addVehicleType(name) {
  const res = await request("/api/vehicle-types", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return res.json();
}

/**
 * 차량 유형 삭제
 */
export async function deleteVehicleType(id) {
  await request(`/api/vehicle-types/${id}`, {
    method: "DELETE",
  });
}
