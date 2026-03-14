export function createApiClient(basePath) {
  const BASE_URL = import.meta.env.PROD ? basePath : "";
  const ENTRY_URL = "/entry";

  async function request(endpoint, options = {}) {
    const config = {
      headers: { "Content-Type": "application/json" },
      ...options,
    };

    const res = await fetch(`${BASE_URL}${endpoint}`, config);

    if (res.status === 401) {
      window.location.href = `/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("인증이 필요합니다.");
    }

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `요청 실패 (${res.status})`);
    }

    return res;
  }

  async function fetchEntryYears() {
    const res = await fetch(`${ENTRY_URL}/api/years`);
    if (res.status === 401) {
      window.location.href = `/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("인증이 필요합니다.");
    }
    if (!res.ok) throw new Error("연도 정보를 가져올 수 없습니다.");
    return res.json();
  }

  async function fetchEntries(year) {
    const qs = year != null ? `?year=${year}` : "";
    const res = await fetch(`${ENTRY_URL}/api/entries${qs}`);
    if (res.status === 401) {
      window.location.href = `/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("인증이 필요합니다.");
    }
    if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
    return res.json();
  }

  return { request, fetchEntryYears, fetchEntries, BASE_URL, ENTRY_URL };
}
