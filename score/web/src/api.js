const BASE_URL = import.meta.env.PROD ? "/score" : "";
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
export async function fetchEntryYears() {
  const res = await fetch(`${ENTRY_URL}/api/years`);
  if (!res.ok) throw new Error("연도 정보를 가져올 수 없습니다.");
  return res.json();
}

/* ============================================
   Score API
   ============================================ */
export async function fetchScore(year) {
  const res = await request(`/api/score?year=${year}`);
  return res.json();
}

export async function selectRecord(year, event_type, team_num, table_name, record_rowid) {
  await request("/api/score/record", {
    method: "PUT",
    body: JSON.stringify({ year, event_type, team_num, table_name, record_rowid }),
  });
}

export async function deselectRecord(year, event_type, team_num) {
  await request("/api/score/record", {
    method: "DELETE",
    body: JSON.stringify({ year, event_type, team_num }),
  });
}
