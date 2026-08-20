import { createApiClient } from "@shared/api-base.js";

const { request } = createApiClient("/competition/api/v1/registration");

async function json(endpoint, options) {
  const response = await request(endpoint, options);
  return response.json();
}

const body = (value) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

export const fetchStatus = (year) => json(`/api/status?year=${year}`);
export const lookupRegistration = (data) => json("/api/lookup", { method: "POST", ...body(data) });
export const fetchTeam = (number, year) => json(`/api/team/${number}?year=${year}`);
export const fetchQueue = (year) => json(`/api/queue?year=${year}`);
export const createRegistration = (data) => json("/api/queue", { method: "POST", ...body(data) });
export const callRegistration = (id) => json(`/api/queue/${id}/call`, { method: "POST" });
export const completeRegistration = (id) => json(`/api/queue/${id}/done`, { method: "POST" });
export const cancelRegistration = (id) => json(`/api/queue/${id}/cancel`, { method: "POST" });
export const updateSettings = (data) => json("/api/settings", { method: "PATCH", ...body(data) });

export function errorMessage(error) {
  return error?.data?.message || error?.message || "요청을 처리할 수 없습니다.";
}

export function eventsUrl(year) {
  return `/competition/api/v1/registration/events?year=${encodeURIComponent(year)}`;
}
