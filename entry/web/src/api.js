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
 *
 * 번호는 그대로 둔 채 학교/팀명이 바뀌면(명칭 정정 vs 팀 교체) 서버는 409와 함께
 * `{ message, ambiguous }`를 반환한다. bulk와 동일하게 ambiguous를 throw에 실어
 * 호출부가 운영자에게 의도를 물은 뒤 intent(retain|replacement)로 재전송하게 한다.
 */
export async function updateEntry({ num, univ, team, type, prev, intent }, year) {
  const base = import.meta.env.PROD ? "/entry" : "";
  const body = { num, univ, team, type };
  if (intent) body.intent = intent;

  const res = await fetch(`${base}/api/entries/${prev}${yearParam(year)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    window.location.href = `/auth/api/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("인증이 필요합니다.");
  }
  if (res.status === 409) {
    const payload = await res.json().catch(() => null);
    if (payload?.ambiguous) {
      const e = new Error(payload.message || "선택이 필요합니다.");
      e.ambiguous = payload.ambiguous;
      throw e;
    }
  }
  if (!res.ok) {
    throw new Error((await res.text()) || `요청 실패 (${res.status})`);
  }
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
 *
 * 동일 번호에서 팀이 바뀐 경우(명칭 정정 vs 팀 교체) 서버는 409와 함께
 * `{ message, ambiguous }`를 반환한다. 이때 ambiguous를 throw에 실어 호출부가
 * 운영자에게 의도를 물은 뒤 replacements/retains로 재전송할 수 있게 한다.
 */
export async function uploadEntries(data, year, { replacements = [], retains = [] } = {}) {
  const base = import.meta.env.PROD ? "/entry" : "";
  const body = { data };
  if (replacements.length) body.replacements = replacements;
  if (retains.length) body.retains = retains;

  const res = await fetch(`${base}/api/entries/bulk${yearParam(year)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    window.location.href = `/auth/api/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("인증이 필요합니다.");
  }
  if (res.status === 409) {
    const payload = await res.json().catch(() => null);
    if (payload?.ambiguous) {
      const e = new Error(payload.message || "선택이 필요합니다.");
      e.ambiguous = payload.ambiguous;
      throw e;
    }
  }
  if (!res.ok) {
    throw new Error((await res.text()) || `요청 실패 (${res.status})`);
  }
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
