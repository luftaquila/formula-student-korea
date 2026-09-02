import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntries } = createApiClient("/competition/api/v1/traffic");

export { fetchEntries };

// 브라우저 탭(세션)별 고유 식별자. 같은 계정으로 로그인한 다른 탭과 제어권(lease)을 구분하기
// 위해 제어/lease 요청에 X-Session-Id로 동봉한다(서버는 email#sid로 controller 식별). request는
// options.headers를 통째로 덮으므로 Content-Type을 함께 병합한다.
const SESSION_ID =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function ctrlRequest(endpoint, options = {}) {
  return request(endpoint, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID, ...(options.headers || {}) },
  });
}

export async function fetchRecord(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}`);
  return res.json();
}

// 반환: { name, record } — name은 실제 테이블명("FSK <year> <이름>"), record는 rowid 포함 생성 행.
// 내구처럼 같은 기록에 랩을 이어붙이는 호출자가 PATCH 대상(name/rowid)을 받는 데 쓴다.
export async function addRecord(name, data) {
  const res = await request("/api/records", {
    method: "POST",
    body: JSON.stringify({ name, data }),
  });
  return res.json();
}

export async function deleteRecord(name) {
  await request(`/api/records/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function deleteRecordRow(name, rowid) {
  const res = await request(`/api/records/${encodeURIComponent(name)}/${rowid}`, {
    method: "DELETE",
  });
  return res.json();
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
  const res = await request("/api/wireless/ingest", {
    method: "POST",
    body: JSON.stringify(batch),
  });
  return res.json();
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

// 센서 디바운스 창(ms) 설정. 무선 공용(서버 저장 + SSE 공유).
export async function putWirelessDebounce(ms) {
  const res = await request("/api/wireless/debounce", {
    method: "PUT",
    body: JSON.stringify({ ms }),
  });
  return res.json();
}

export async function fetchWirelessEvents(since = 0, limit = 200) {
  const res = await request(`/api/wireless/events?since=${since}&limit=${limit}`);
  return res.json();
}

// 경기 arm/disarm/reset(green=arm). 가상 경기를 전 클라에 공유. body: {event_type, action, green_tick?, team?, event_name?}
export async function armWirelessEvent(body) {
  const res = await ctrlRequest("/api/wireless/arm", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

// 경기 독점 제어 lease 획득/갱신(heartbeat).
export async function claimWirelessLease(eventType) {
  const res = await ctrlRequest(`/api/wireless/lease/${encodeURIComponent(eventType)}`, { method: "POST" });
  return res.json();
}

// 경기 lease 해제.
export async function releaseWirelessLease(eventType) {
  const res = await ctrlRequest(`/api/wireless/lease/${encodeURIComponent(eventType)}`, { method: "DELETE" });
  return res.json();
}

// 서버 시각(epoch ms). 라이브 클럭을 전 클라 동기화하기 위한 오프셋 추정용.
export async function fetchServerTime() {
  const res = await request("/api/time");
  return res.json();
}

// 경기 선택(팀·이벤트명) 공유 — 서버 기록 엔진의 귀속 정보.
export async function selectWirelessEvent(body) {
  const res = await ctrlRequest("/api/wireless/select", { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

// 현재 무선 런의 DNS/DNF/DSQ 판정을 저장한다. 세션 선택 정보로 귀속된다.
export async function statusWirelessEvent(eventType, status) {
  const res = await ctrlRequest("/api/wireless/status", {
    method: "POST",
    body: JSON.stringify({ event_type: eventType, status }),
  });
  return res.json();
}

// 물리 신호등 원격 제어(비-브리지 컨트롤러 → 서버 → 브리지 시리얼). 물리 지정 경기만.
export async function commandWirelessPhysical(eventType, action) {
  const res = await ctrlRequest("/api/wireless/command", { method: "POST", body: JSON.stringify({ event_type: eventType, action }) });
  return res.json();
}
