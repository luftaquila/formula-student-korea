import { createApiClient } from "@shared/api-base.js";

const { request, fetchEntries, fetchEntryYears, fetchVehicleTypes } = createApiClient("/competition/api/v1/inspection");

export { fetchEntries, fetchEntryYears, fetchVehicleTypes };

/* ============================================
   Sheet API
   ============================================ */
export async function fetchSheetTemplate(year) {
  const res = await request(`/api/sheet/template?year=${year}`);
  return res.json();
}

export async function createSheetNode(data) {
  const res = await request("/api/sheet/template", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateSheetNode(id, data) {
  await request(`/api/sheet/template/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteSheetNode(id) {
  await request(`/api/sheet/template/${id}`, {
    method: "DELETE",
  });
}

export async function reorderSheetNodes(items) {
  await request("/api/sheet/template/reorder", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

export async function copySheetTemplate(fromYear, toYear) {
  const res = await request("/api/sheet/template/copy", {
    method: "POST",
    body: JSON.stringify({ from_year: fromYear, to_year: toYear }),
  });
  return res.json();
}

export async function importSheetTemplate(year, template) {
  await request("/api/sheet/template/import", {
    method: "POST",
    body: JSON.stringify({ year, template }),
  });
}

export async function searchSheetRules(year, document, query) {
  const params = new URLSearchParams({ year: String(year) });
  if (document) params.set("document", document);
  if (query) params.set("q", query);
  const res = await request(`/api/sheet/rules/search?${params}`);
  return res.json();
}

export async function updateSheetRuleRefs(itemId, status, ruleKeys = []) {
  const res = await request(`/api/sheet/template/${itemId}/rule-refs`, {
    method: "PUT",
    body: JSON.stringify({ status, rule_keys: ruleKeys }),
  });
  return res.json();
}

export async function importSheetRuleRefs(year, template) {
  const res = await request("/api/sheet/template/rule-refs/import", {
    method: "POST",
    body: JSON.stringify({ year, template }),
  });
  return res.json();
}

export async function syncSheetRuleRefs(fromYear, toYear) {
  const res = await request("/api/sheet/template/rule-refs/sync", {
    method: "POST",
    body: JSON.stringify({ from_year: fromYear, to_year: toYear }),
  });
  return res.json();
}

export async function revalidateSheetRuleRefs(year) {
  const res = await request("/api/sheet/template/rule-refs/revalidate", {
    method: "POST",
    body: JSON.stringify({ year }),
  });
  return res.json();
}

export function sheetRuleLink(itemId, referenceIndex) {
  return `/competition/api/v1/inspection/sheet/rule-link/${encodeURIComponent(itemId)}/${encodeURIComponent(referenceIndex)}`;
}

export async function fetchSheetSummary(year) {
  const res = await request(`/api/sheet/summary?year=${year}`);
  return res.json();
}

export async function fetchSheetData(year, num) {
  const res = await request(`/api/sheet/data/${year}/${num}`);
  return res.json();
}

export async function updateSheetAnswer(data) {
  const res = await request("/api/sheet/answer", {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateSheetMemo(data) {
  const res = await request("/api/sheet/memo", {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateSheetCategoryResult(data) {
  await request("/api/sheet/category-result", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}
