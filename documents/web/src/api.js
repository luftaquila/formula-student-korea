import { createApiClient } from "@shared/api-base.js";

const api = createApiClient("/competition/api/v1/documents");

export const { request, fetchEntryYears, fetchVehicleTypes } = api;

// Documents는 엔트리 활성 상태와 무관하게 모든 팀을 다루므로, 내부 자격으로
// includeInactive 목록을 조회하는 Documents 백엔드 프록시를 사용한다.
export async function fetchEntries(year) {
  const qs = year != null ? `?year=${year}` : "";
  const res = await request(`/api/entries${qs}`);
  return res.json();
}

export async function fetchAdminEntries(year) {
  const qs = year != null ? `?year=${year}` : "";
  const res = await request(`/api/admin/entries${qs}`);
  return res.json();
}
