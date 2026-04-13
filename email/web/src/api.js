import { createApiClient } from "@shared/api-base.js";

const api = createApiClient("/email");

export async function fetchStats() {
  const res = await api.request("/api/stats");
  return res.json();
}

export async function fetchQuota() {
  const res = await api.request("/api/quota");
  return res.json();
}

export async function fetchEmails(params = {}) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", params.limit);
  if (params.offset != null) qs.set("offset", params.offset);
  if (params.status) qs.set("status", params.status);
  const query = qs.toString();
  const res = await api.request(`/api/emails${query ? "?" + query : ""}`);
  return res.json();
}

export async function sendEmail(payload) {
  const res = await api.request("/api/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function fetchRecipients() {
  const res = await api.request("/api/recipients");
  return res.json();
}

export async function fetchConfig() {
  const res = await api.request("/api/config");
  return res.json();
}

export async function updateConfig(configs) {
  const res = await api.request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ configs }),
  });
  return res.json();
}

export async function testEmail(recipient) {
  const res = await api.request("/api/test-email", {
    method: "POST",
    body: JSON.stringify({ recipient }),
  });
  return res.json();
}

export async function testSms(recipient) {
  const res = await api.request("/api/test-sms", {
    method: "POST",
    body: JSON.stringify({ recipient }),
  });
  return res.json();
}

export async function resetConfig(group) {
  const res = await api.request("/api/config/reset", {
    method: "POST",
    body: JSON.stringify({ group }),
  });
  return res.json();
}
