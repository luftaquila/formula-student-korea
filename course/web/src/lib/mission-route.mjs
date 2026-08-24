function radians(value) {
  return value * Math.PI / 180;
}

const MISSION_ROUTE_COLOR_STOPS = Object.freeze([
  Object.freeze([34, 197, 94]),
  Object.freeze([234, 179, 8]),
  Object.freeze([249, 115, 22]),
  Object.freeze([239, 68, 68]),
]);

export function missionRouteProgressColor(index, segmentCount) {
  const count = Math.max(1, Number(segmentCount) || 1);
  const progress = count <= 1 ? 0 : Math.max(0, Math.min(1, Number(index) / (count - 1)));
  const scaled = progress * (MISSION_ROUTE_COLOR_STOPS.length - 1);
  const stopIndex = Math.min(Math.floor(scaled), MISSION_ROUTE_COLOR_STOPS.length - 2);
  const localProgress = scaled - stopIndex;
  const start = MISSION_ROUTE_COLOR_STOPS[stopIndex];
  const end = MISSION_ROUTE_COLOR_STOPS[stopIndex + 1];
  const channels = start.map((value, channel) => Math.round(
    value + (end[channel] - value) * localProgress,
  ));
  return `rgb(${channels.join(",")})`;
}

export function missionRouteMapSegments(items) {
  const valid = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng));
  const segmentCount = Math.max(0, valid.length - 1);
  return valid.slice(0, -1).map((from, index) => ({
    from: from.item,
    to: valid[index + 1].item,
    fromIndex: from.index,
    toIndex: valid[index + 1].index,
    color: missionRouteProgressColor(index, segmentCount),
  }));
}

// Geographic chevron points keep direction arrows aligned with the route when
// leaflet-rotate turns the map. Pixel/CSS-rotated icons would need their angle
// corrected after every bearing change.
export function missionRouteDirectionArrow(from, to) {
  if (![from?.lat, from?.lng, to?.lat, to?.lng].every(Number.isFinite)) return [];
  const meanLat = radians((from.lat + to.lat) / 2);
  const metersPerLat = 110540;
  const metersPerLng = 111320 * Math.cos(meanLat);
  const east = (to.lng - from.lng) * metersPerLng;
  const north = (to.lat - from.lat) * metersPerLat;
  const distance = Math.hypot(east, north);
  if (distance < 0.5 || Math.abs(metersPerLng) < 1e-6) return [];

  const forwardEast = east / distance;
  const forwardNorth = north / distance;
  const leftEast = -forwardNorth;
  const leftNorth = forwardEast;
  const length = Math.min(3, Math.max(0.8, distance * 0.28), distance * 0.62);
  const halfWidth = Math.max(0.35, length * 0.42);
  const tip = {
    lat: from.lat + (to.lat - from.lat) * 0.56,
    lng: from.lng + (to.lng - from.lng) * 0.56,
  };
  const point = (back, side) => ({
    lat: tip.lat + (-back * forwardNorth + side * leftNorth) / metersPerLat,
    lng: tip.lng + (-back * forwardEast + side * leftEast) / metersPerLng,
  });
  return [point(length, halfWidth), tip, point(length, -halfWidth)];
}

// Match the main map's leaflet-rotate raster workaround. An exact 180-degree
// transform can enter a browser fast path that leaves satellite tiles blank.
export function renderMissionMapBearing(bearing) {
  return bearing === 180 ? 179.9 : bearing;
}

export function routeDistance(a, b) {
  const earth = 6371000;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function filterCones(cones, { query = "", side = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return cones.filter((cone, index) => {
    if (side !== "all" && cone.side !== side) return false;
    if (!needle) return true;
    if (/^\d+$/.test(needle)) {
      return String(cone.id) === needle || String(index + 1) === needle;
    }
    return [cone.id, index + 1, cone.side, cone.lat, cone.lng]
      .some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

const MISSION_SIDE_LABELS = Object.freeze({ left: "왼쪽", center: "중앙", right: "오른쪽" });
const MISSION_SIDE_SHORT_LABELS = Object.freeze({ left: "L", center: "C", right: "R" });

export function missionConeDisplayName(cone, sideRanks) {
  if (!cone) return "알 수 없는 콘";
  const rank = sideRanks.get(cone.id ?? cone.cone_id);
  return `${MISSION_SIDE_LABELS[cone.side] || cone.side} ${rank ? `#${rank}` : "콘"}`;
}

export function missionConeShortName(cone, sideRanks) {
  if (!cone) return "?";
  return `${MISSION_SIDE_SHORT_LABELS[cone.side] || "?"}-${sideRanks.get(cone.id ?? cone.cone_id) || "?"}`;
}

// Repeated visits at the same physical cone share one map marker. A cone that
// moved between a stable snapshot and a newly-added occurrence remains split at
// its two reviewed coordinates instead of being silently drawn at the first one.
export function groupRouteMapVisits(items) {
  const groups = new Map();
  items.forEach((item, index) => {
    if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) return;
    const key = `${item.cone_id}\u0000${item.lat}\u0000${item.lng}`;
    const visits = groups.get(key) || [];
    visits.push({ item, index });
    groups.set(key, visits);
  });
  return [...groups.values()];
}

// Open nearest-neighbour route with a bounded 2-opt cleanup. It preserves each
// occurrence object (and therefore duplicate cone visits and stable waypoint IDs).
// The distance/reversal work ceiling is deterministic so a very large course cannot
// monopolize the browser main thread before the mission builder is even visible.
export const DEFAULT_ROUTE_OPTIMIZATION_EVALUATIONS = 200000;

export function optimizeConeRoute(items, start = null, maxPasses = 12, options = {}) {
  if (items.length < 2) return [...items];
  const requestedBudget = Number.isInteger(options.maxEvaluations) && options.maxEvaluations > 0
    ? options.maxEvaluations : DEFAULT_ROUTE_OPTIMIZATION_EVALUATIONS;
  const evaluationBudget = Math.max(items.length, requestedBudget);
  const nearestNeighborBudget = Math.max(items.length, Math.floor(evaluationBudget / 2));
  const candidatesPerStep = Math.max(1, Math.floor(nearestNeighborBudget / items.length));
  let evaluations = 0;
  const measuredDistance = (a, b) => {
    evaluations += 1;
    if (typeof options.onEvaluation === "function") options.onEvaluation(evaluations);
    return routeDistance(a, b);
  };
  const remaining = [...items];
  const ordered = [];
  let cursor = start && Number.isFinite(start.lat) && Number.isFinite(start.lng)
    ? start : remaining[0];
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = evaluations < nearestNeighborBudget
      ? measuredDistance(cursor, remaining[0]) : Infinity;
    const scanLength = Math.min(remaining.length, candidatesPerStep);
    for (let index = 1; index < scanLength && evaluations < nearestNeighborBudget; index += 1) {
      const distance = measuredDistance(cursor, remaining[index]);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    cursor = remaining[best];
    // Swap removal avoids a second O(n²) cost from shifting the remaining array.
    remaining[best] = remaining[remaining.length - 1];
    remaining.pop();
    ordered.push(cursor);
  }

  for (let pass = 0; pass < maxPasses && evaluations < evaluationBudget; pass += 1) {
    let improved = false;
    for (let left = 0; left < ordered.length - 2 && evaluations < evaluationBudget; left += 1) {
      const beforeLeft = left === 0 ? start : ordered[left - 1];
      if (!beforeLeft) continue;
      for (let right = left + 1; right < ordered.length - 1 && evaluations + 4 <= evaluationBudget; right += 1) {
        const afterRight = ordered[right + 1];
        const oldDistance = measuredDistance(beforeLeft, ordered[left])
          + measuredDistance(ordered[right], afterRight);
        const newDistance = measuredDistance(beforeLeft, ordered[right])
          + measuredDistance(ordered[left], afterRight);
        if (newDistance + 1e-6 < oldDistance) {
          const swaps = Math.floor((right - left + 1) / 2);
          if (evaluations + swaps > evaluationBudget) {
            evaluations = evaluationBudget;
            if (typeof options.onEvaluation === "function") options.onEvaluation(evaluations);
            break;
          }
          for (let offset = 0; offset < swaps; offset += 1) {
            const a = left + offset;
            const b = right - offset;
            [ordered[a], ordered[b]] = [ordered[b], ordered[a]];
            evaluations += 1;
            if (typeof options.onEvaluation === "function") options.onEvaluation(evaluations);
          }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return ordered;
}

export function moveRouteItem(items, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)
      || from < 0 || from >= items.length || to < 0 || to >= items.length
      || from === to) return [...items];
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function duplicateConeIds(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.cone_id, (counts.get(item.cone_id) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([coneId]) => coneId);
}
