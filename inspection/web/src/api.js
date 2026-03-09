const BASE_URL = import.meta.env.PROD ? "/inspection" : "";
const ENTRY_URL = import.meta.env.PROD ? "/entry" : "/entry";

/**
 * 공통 fetch 래퍼
 */
async function request(endpoint, options = {}) {
  const config = {
    headers: { "Content-Type": "application/json" },
    ...options,
  };

  const res = await fetch(`${BASE_URL}${endpoint}`, config);

  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || `요청 실패 (${res.status})`);
  }

  return res;
}

/* ============================================
   Entry API (외부 서비스)
   ============================================ */
export async function fetchEntries(year) {
  const qs = year != null ? `?year=${year}` : "";
  const res = await fetch(`${ENTRY_URL}/api/entries${qs}`);
  if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
  return res.json();
}

export async function fetchEntryYears() {
  const res = await fetch(`${ENTRY_URL}/api/years`);
  if (!res.ok) throw new Error("연도 정보를 가져올 수 없습니다.");
  return res.json();
}

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
  await request("/api/sheet/template/copy", {
    method: "POST",
    body: JSON.stringify({ from_year: fromYear, to_year: toYear }),
  });
}

export async function importSheetTemplate(year, template) {
  await request("/api/sheet/template/import", {
    method: "POST",
    body: JSON.stringify({ year, template }),
  });
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
  await request("/api/sheet/answer", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function updateSheetMemo(data) {
  await request("/api/sheet/memo", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function updateSheetCategoryResult(data) {
  await request("/api/sheet/category-result", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function updateSheetInspector(data) {
  await request("/api/sheet/inspector", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}
