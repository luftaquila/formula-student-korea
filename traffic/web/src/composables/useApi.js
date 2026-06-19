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

export async function toggleRecordVisibility(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}/visibility`, {
    method: "PUT",
  });
  return res.json();
}

export async function toggleEventMode(eventType) {
  const res = await request(`/api/event-modes/${encodeURIComponent(eventType)}`, {
    method: "PUT",
  });
  return res.json();
}

/* ── 무선 LoRa 계측 ───────────────────────────────────────────────── */

export async function fetchWirelessState() {
  const res = await request("/api/wireless/state");
  return res.json();
}

export async function fetchWirelessMapping() {
  const res = await request("/api/wireless/mapping");
  return res.json();
}

export async function putWirelessMapping(nodeId, body) {
  const res = await request(`/api/wireless/mapping/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function deleteWirelessMapping(nodeId) {
  await request(`/api/wireless/mapping/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
}

export async function ingestWireless(batch) {
  await request("/api/wireless/ingest", {
    method: "POST",
    body: JSON.stringify(batch),
  });
}

export async function reportLight(state) {
  const res = await request("/api/wireless/light", {
    method: "POST",
    body: JSON.stringify(state),
  });
  return res.json();
}

// 브리지 연결 해제 시 서버에 즉시 오프라인 보고(15s 워치독 대기 없이).
export async function reportBridgeOffline() {
  await request("/api/wireless/bridge/offline", { method: "POST" });
}

// 물리 신호등을 사용할 경기 지정(eventType=null → 없음, 전부 가상).
export async function putPhysicalEvent(eventType) {
  const res = await request("/api/wireless/physical-event", {
    method: "PUT",
    body: JSON.stringify({ event_type: eventType }),
  });
  return res.json();
}

export async function fetchWirelessEvents(since = 0, limit = 200) {
  const res = await request(`/api/wireless/events?since=${since}&limit=${limit}`);
  return res.json();
}
