import { createApiClient } from "@shared/api-base.js";

const { request, BASE_URL } = createApiClient("/competition/api/v1");

function yearParam(year, prefix = "?") {
  return year != null ? `${prefix}year=${year}` : "";
}

export async function fetchYears() {
  const res = await request("/meta");
  return (await res.json()).years;
}

export async function fetchEntries(year) {
  const res = await request(`/teams?includeInactive=true${yearParam(year, "&")}`);
  const teams = await res.json();
  return Object.fromEntries(teams.map((team) => [team.number, {
    id: team.id,
    num: team.number,
    univ: team.university,
    team: team.name,
    vehicleTypeId: team.vehicleTypeId,
    type: team.vehicleType,
    active: team.active,
  }]));
}

export async function setEntryActive(id, active) {
  await request(`/teams/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
}

export async function addEntry({ num, univ, team, vehicleTypeId }, year) {
  await request(`/teams${yearParam(year)}`, {
    method: "POST",
    body: JSON.stringify({ number: num, university: univ, name: team, vehicleTypeId }),
  });
}

export async function updateEntry({ id, num, univ, team, vehicleTypeId }) {
  await request(`/teams/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ number: num, university: univ, name: team, vehicleTypeId }),
  });
}

export async function uploadEntries(data, year) {
  let payload;
  try { payload = typeof data === "string" ? JSON.parse(data) : data; }
  catch { throw new Error("JSON 파일을 읽을 수 없습니다."); }
  await request(`/teams/import${yearParam(year)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getDownloadUrl(year) {
  return `${BASE_URL}/teams/export${yearParam(year)}`;
}

export async function fetchVehicleTypes(year) {
  const res = await request(`/vehicle-types${yearParam(year)}`);
  return res.json();
}

export async function addVehicleType(name, color, year) {
  const res = await request(`/vehicle-types${yearParam(year)}`, {
    method: "POST", body: JSON.stringify({ name, color }),
  });
  return res.json();
}

export async function updateVehicleType(id, data) {
  await request(`/vehicle-types/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ...data, sortOrder: data.sort_order ?? data.sortOrder }),
  });
}

export async function deleteVehicleType(id) {
  await request(`/vehicle-types/${id}`, { method: "DELETE" });
}
