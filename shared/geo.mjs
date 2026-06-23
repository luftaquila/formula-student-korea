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
