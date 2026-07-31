// Geographic helpers used by both frontend (MapView) and backend (course).
// Keep this file dependency-free so it can be imported from browser and Node.

const R_EARTH = 6371e3; // meters

function toRad(d) {
  return (d * Math.PI) / 180;
}

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

// 좌표 표시 자릿수. 저장은 double 그대로(REAL, 반올림 없음)이고 이 상수는 화면
// 표시에만 쓴다. 8자리 ≈ 1.1 mm — RTK fix 실측 정확도(수 cm)보다 촘촘해 반올림이
// 의미 있는 정보를 지우지 않는다. 예전에는 화면마다 5·6·7자리로 갈려 같은 점의
// 좌표가 패널마다 다르게 읽혔다. 표시용 좌표는 반드시 아래 두 함수를 거친다.
export const COORD_DECIMALS = 8;

export function formatCoord(v) {
  return Number(v).toFixed(COORD_DECIMALS);
}

export function formatLatLng(lat, lng) {
  return `${formatCoord(lat)}, ${formatCoord(lng)}`;
}

// 고도 표시 자릿수(m). 저장은 좌표와 같이 double 그대로이고 이 상수는 표시용이다.
// 2자리 = 1 cm — 수직 정확도(v_acc)가 RTK fix에서 수 cm이므로 1 cm가 측정이 실제로
// 담보하는 마지막 자리다. 예전에는 콘 목록만 1자리(10 cm)여서 같은 콘이 목록에서는
// 12.3 m, 상세 패널에서는 12.35 m로 읽혔다. 단위 " m"는 호출부가 붙인다.
export const ALT_DECIMALS = 2;

export function formatAlt(v) {
  return Number(v).toFixed(ALT_DECIMALS);
}
