export function createApiClient(basePath) {
  const BASE_URL = import.meta.env.PROD ? basePath : "";

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

  return { request, BASE_URL };
}
