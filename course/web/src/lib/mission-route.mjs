function radians(value) {
  return value * Math.PI / 180;
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

// Open nearest-neighbour route with a bounded 2-opt cleanup. It preserves each
// occurrence object (and therefore duplicate cone visits and stable waypoint IDs).
export function optimizeConeRoute(items, start = null, maxPasses = 12) {
  if (items.length < 2) return [...items];
  const remaining = [...items];
  const ordered = [];
  let cursor = start && Number.isFinite(start.lat) && Number.isFinite(start.lng)
    ? start : remaining[0];
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = routeDistance(cursor, remaining[0]);
    for (let index = 1; index < remaining.length; index += 1) {
      const distance = routeDistance(cursor, remaining[index]);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    cursor = remaining.splice(best, 1)[0];
    ordered.push(cursor);
  }

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let left = 0; left < ordered.length - 2; left += 1) {
      const beforeLeft = left === 0 ? start : ordered[left - 1];
      if (!beforeLeft) continue;
      for (let right = left + 1; right < ordered.length - 1; right += 1) {
        const afterRight = ordered[right + 1];
        const oldDistance = routeDistance(beforeLeft, ordered[left])
          + routeDistance(ordered[right], afterRight);
        const newDistance = routeDistance(beforeLeft, ordered[right])
          + routeDistance(ordered[left], afterRight);
        if (newDistance + 1e-6 < oldDistance) {
          const reversed = ordered.slice(left, right + 1).reverse();
          ordered.splice(left, reversed.length, ...reversed);
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
