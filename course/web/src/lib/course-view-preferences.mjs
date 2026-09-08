export function normalizeMapBearing(value) {
  const bearing = Number(value);
  return Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : 0;
}

// Avoid the browser's raster-tile fast path at an exact half-turn.
export function renderMapBearing(value) {
  return value === 180 ? 179.9 : value;
}

export function readPublicCoursePreferences(storage) {
  const read = (key) => { try { return storage.getItem(`publicCourse.${key}`); } catch { return null; } };
  const id = Number(read("selectedId"));
  let overlays = {};
  try {
    const saved = JSON.parse(read("overlays"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      overlays = Object.fromEntries(Object.entries(saved).filter(([, value]) => value === true));
    }
  } catch { /* Invalid browser storage falls back to default preferences. */ }
  return {
    selectedId: Number.isSafeInteger(id) && id > 0 ? id : null,
    overlays,
    showCenterline: read("showCenterline") !== "false",
    mapBearing: normalizeMapBearing(read("mapBearing")),
  };
}

export function savePublicCoursePreference(storage, key, value) {
  try { storage.setItem(`publicCourse.${key}`, typeof value === "object" ? JSON.stringify(value) : String(value)); } catch { /* Storage can be disabled. */ }
}
