export function createApiClient(basePath) {
  const competitionApi = basePath.startsWith("/competition/api/v1");
  const BASE_URL = import.meta.env.PROD || competitionApi ? basePath : "";
  const ENTRY_URL = "/competition/api/v1";

  function serviceEndpoint(endpoint) {
    return competitionApi ? endpoint.replace(/^\/api(?=\/|$)/, "") : endpoint;
  }

  async function request(endpoint, options = {}) {
    const config = {
      headers: { "Content-Type": "application/json" },
      ...options,
    };

    const res = await fetch(`${BASE_URL}${serviceEndpoint(endpoint)}`, config);

    if (res.status === 401) {
      const kioskPath = /^\/(?:queue|registration)\/register(?:\/|$)/.test(window.location.pathname);
      window.location.href = kioskPath
        ? "/auth/device"
        : `/auth/api/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("인증이 필요합니다.");
    }

    if (!res.ok) {
      const message = await res.text();
      let data = null;
      try {
        data = JSON.parse(message);
      } catch {
        data = null;
      }
      const error = new Error(data && typeof data.message === "string"
        ? data.message : (message || `요청 실패 (${res.status})`));
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return res;
  }

  async function fetchEntryYears() {
    const res = await fetch(`${ENTRY_URL}/meta`);
    if (!res.ok) throw new Error("연도 정보를 가져올 수 없습니다.");
    const data = await res.json();
    return data.years;
  }

  async function fetchEntries(year) {
    const qs = year != null ? `?year=${year}` : "";
    const res = await fetch(`${ENTRY_URL}/teams${qs}`);
    if (!res.ok) throw new Error("엔트리 정보를 가져올 수 없습니다.");
    const data = await res.json();
    return Object.fromEntries(data.map(team => [team.number, {
      id: team.id,
      teamId: team.id,
      univ: team.university,
      team: team.name,
      type: team.vehicleType,
      active: team.active,
    }]));
  }

  async function fetchVehicleTypes(year) {
    const qs = year != null ? `?year=${year}` : "";
    const res = await fetch(`${ENTRY_URL}/vehicle-types${qs}`);
    if (!res.ok) throw new Error("차량 유형 정보를 가져올 수 없습니다.");
    return res.json();
  }

  return { request, fetchEntryYears, fetchEntries, fetchVehicleTypes, BASE_URL };
}
