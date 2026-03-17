import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntries } = createApiClient("/traffic");

export { fetchEntries };

export async function fetchRecord(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}`);
  return res.json();
}

export async function addRecord(name, data) {
  await request("/api/records", {
    method: "POST",
    body: JSON.stringify({ name, data }),
  });
}

export async function deleteRecord(name) {
  await request(`/api/records/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function updateRecord(name, rowid, field, value) {
  const res = await request(`/api/records/${encodeURIComponent(name)}/${rowid}`, {
    method: "PATCH",
    body: JSON.stringify({ field, value }),
  });
  return res.json();
}

export async function fetchControllers() {
  const res = await request("/api/controllers");
  return res.json();
}

export async function addControllerLog(timestamp, data) {
  await request("/api/controllers", {
    method: "POST",
    body: JSON.stringify({ timestamp, data }),
  });
}

export async function deleteControllers() {
  await request("/api/controllers", {
    method: "DELETE",
  });
}

export async function toggleEventMode(eventType) {
  const res = await request(`/api/event-modes/${encodeURIComponent(eventType)}`, {
    method: "PUT",
  });
  return res.json();
}
