const BASE_URL = import.meta.env.PROD ? "/traffic" : "/traffic";

/**
 * 공통 fetch 래퍼
 * @param {string} endpoint - API 엔드포인트
 * @param {RequestInit} options - fetch 옵션
 * @returns {Promise<Response>}
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

/**
 * 특정 기록 조회
 */
export async function fetchRecord(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}`);
  return res.json();
}
