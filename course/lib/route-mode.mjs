// How a course's marker route is realized.
//
// Route markers are the only UI for travel order, but most courses (endurance,
// autocross) are one simple closed loop where the markers say nothing more than
// "start here, go this way round". Those must keep using the established circuit
// engine in centerline.mjs so the drawn path and the exported track stay exactly
// what they were before markers existed — the medial-graph router in
// guided-route.mjs samples differently and would shift geometry on every
// already-validated course.
//
// So the marker order is classified, not blindly routed:
//
//   auto      fewer than two resolvable steps — no marker constraint at all, so
//             the caller's stored start/reverse fallback applies unchanged.
//   oriented  the steps are stations along one loop in one consistent direction.
//             computeCenterline does the geometry; the markers only supply
//             `start` and `reverse`.
//   guided    the steps re-use pavement or leave the loop (skidpad's two circles
//             and its entry/exit arms). Only computeGuidedRoute can express it.
//
// Two markers on a closed loop are inherently ambiguous — you reach the second
// one going either way round — so the first hop resolves by SHORTEST ARC. Place
// a third marker on the far side to demand the long way round.

import { computeCenterline } from "./centerline.mjs";
import { computeGuidedRoute } from "./guided-route.mjs";

export const ROUTE_MODE = { AUTO: "auto", ORIENTED: "oriented", GUIDED: "guided" };

// A marker is hand-dropped on pavement, not on the computed centre line, so it
// is matched to a station within half the local road width plus this slack.
const MARKER_OFF_CENTRE_SLACK_M = 4;

function projector(lat0) {
  const mlat = 110540.0;
  const mlng = 111320.0 * Math.cos((lat0 * Math.PI) / 180);
  return (a, b) => Math.hypot((a.lng - b.lng) * mlng, (a.lat - b.lat) * mlat);
}

// Ordered step positions, dropping ids with no surviving marker (a deleted
// marker's visits are removed server-side, so this only guards stale clients).
function orderedStops(markers, steps) {
  const byId = new Map((markers || []).map((m) => [m.id, m]));
  const stops = [];
  for (const id of steps || []) {
    const marker = byId.get(id);
    if (marker) stops.push({ id, lat: marker.lat, lng: marker.lng });
  }
  return stops;
}

// A closed centerline repeats station 0 as its last point to re-close the ring.
// Matching or counting over that duplicate would read as a full extra lap, so
// every index here lives in [0, cycleLength).
function cycleLength(centerline) {
  const n = centerline.points.length;
  return centerline.closed && n > 1 ? n - 1 : n;
}

// Station index nearest each stop, or null when any stop sits off the road —
// off-road stops mean the operator is describing something the loop cannot hold.
function stationIndices(centerline, stops, total) {
  const dist = projector(centerline.points[0].lat);
  const indices = [];
  for (const stop of stops) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < total; i++) {
      const d = dist(stop, centerline.points[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    const halfWidth = (centerline.points[best]?.width ?? 0) / 2;
    if (bestD > halfWidth + MARKER_OFF_CENTRE_SLACK_M) return null;
    indices.push(best);
  }
  return indices;
}

// Is the index sequence one consistent sweep along the loop? Returns the travel
// direction (+1 forward, -1 reversed) or null when the order doubles back.
function sweepDirection(indices, total, closed) {
  const advance = (from, to, sign) => {
    const raw = sign > 0 ? to - from : from - to;
    return closed ? (raw + total) % total : raw;
  };
  // The first hop picks the direction: on a closed loop the shorter arc wins, on
  // an open path only one sign can advance at all.
  const forwardFirst = advance(indices[0], indices[1], 1);
  const backwardFirst = advance(indices[0], indices[1], -1);
  let sign;
  if (closed) {
    if (forwardFirst === 0 || backwardFirst === 0) return null;
    sign = forwardFirst <= backwardFirst ? 1 : -1;
  } else {
    if (forwardFirst > 0) sign = 1;
    else if (backwardFirst > 0) sign = -1;
    else return null;
  }
  // Every later hop must keep moving the same way without lapping the loop.
  let travelled = 0;
  for (let i = 0; i < indices.length - 1; i++) {
    const step = advance(indices[i], indices[i + 1], sign);
    if (step <= 0) return null;
    travelled += step;
    if (closed && travelled >= total) return null;
  }
  return sign;
}

/**
 * Resolve a course's centerline the way its markers ask for.
 *
 * @param {Array} cones            course cones
 * @param {Array} markers          route markers ({ id, lat, lng })
 * @param {Array} steps            ordered marker ids (repeats allowed)
 * @param {object} opts
 * @param {number} [opts.step]     sampling step, metres
 * @param {boolean} [opts.metric]  attach the metric frame (needed by the export)
 * @param {{start?:{lat,lng}, reverse?:boolean}} [opts.fallback]
 *        stored course start/direction, applied only in `auto` mode
 * @returns {{mode:string, centerline:object, reverse:boolean}}
 */
export function resolveCourseRoute(cones, markers, steps, opts = {}) {
  const { step = 1.0, metric = false, fallback = {} } = opts;
  const base = { step, metric };
  const stops = orderedStops(markers, steps);

  if (stops.length < 2) {
    return {
      mode: ROUTE_MODE.AUTO,
      centerline: computeCenterline(cones, { ...base, ...fallback }),
      reverse: !!fallback.reverse,
    };
  }

  const guided = () => ({
    mode: ROUTE_MODE.GUIDED,
    centerline: computeGuidedRoute(cones, markers, steps, { step }),
    reverse: false,
  });

  // A stop visited twice means pavement is re-used or the route branches. The
  // one benign repeat is closing back onto the opening marker.
  const closing = stops.length > 2 && stops[stops.length - 1].id === stops[0].id;
  const unique = closing ? stops.slice(0, -1) : stops;
  if (new Set(unique.map((s) => s.id)).size !== unique.length) return guided();
  if (unique.length < 2) return guided();

  const oriented = computeCenterline(cones, { ...base, start: unique[0] });
  if (!oriented.ok) return guided();

  const total = cycleLength(oriented);
  const indices = stationIndices(oriented, unique, total);
  if (!indices) return guided();
  // `start` rotates the loop so the opening marker is station 0; anything else
  // means the marker matched a different part of the course than it anchors.
  if (indices[0] !== 0 && oriented.closed) return guided();

  const sign = sweepDirection(indices, total, oriented.closed);
  if (sign == null) return guided();
  if (sign > 0) return { mode: ROUTE_MODE.ORIENTED, centerline: oriented, reverse: false };
  return {
    mode: ROUTE_MODE.ORIENTED,
    centerline: computeCenterline(cones, { ...base, start: unique[0], reverse: true }),
    reverse: true,
  };
}

/**
 * Marker positions and visit order that reproduce a stored start/reverse pair on
 * a closed loop — used to seed courses that predate route markers.
 *
 * The second marker sits a third of the way round so the shortest-arc rule in
 * `sweepDirection` recovers the same travel direction it was seeded from.
 *
 * @returns {Array<{lat:number,lng:number}>|null} two marker positions in visit order
 */
export function seedOrientationMarkers(cones, { start, reverse, step = 1.0 } = {}) {
  const cl = computeCenterline(cones, { step, ...(start ? { start } : {}), ...(reverse ? { reverse: true } : {}) });
  if (!cl.ok || !cl.closed) return null;
  const n = cl.points.length;
  if (n < 6) return null;
  const second = Math.floor(n / 3);
  if (second === 0) return null;
  return [
    { lat: cl.points[0].lat, lng: cl.points[0].lng },
    { lat: cl.points[second].lat, lng: cl.points[second].lng },
  ];
}
