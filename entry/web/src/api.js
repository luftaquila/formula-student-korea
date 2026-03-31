import { createApiClient } from "@shared/api-base.js";

const { request } = createApiClient("/entry");

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
  const base = import.meta.env.PROD ? "/entry" : "";
  return `${base}/api/entries?download${year != null ? `&year=${year}` : ""}`;
}

/**
 * 차량 유형 목록 조회
 */
export async function fetchVehicleTypes(year) {
  const res = await request(`/api/vehicle-types${yearParam(year)}`);
  return res.json();
}

export async function addVehicleType(name, color, year) {
  const res = await request(`/api/vehicle-types${yearParam(year)}`, {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
  return res.json();
}

export async function updateVehicleType(id, data, year) {
  await request(`/api/vehicle-types/${id}${yearParam(year)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteVehicleType(id, year) {
  await request(`/api/vehicle-types/${id}${yearParam(year)}`, {
    method: "DELETE",
  });
}
