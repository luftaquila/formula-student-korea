// Build the enriched course JSON — the complete data record that ships alongside
// the AC track zip and the 2-panel PNG. It stays re-importable (top-level `name`
// and `cones` are passed through untouched) but adds every numeric artifact the
// track pipeline produced: the projection frame, the centerline (with per-point
// width/elevation/bank), the road edges, the elevation summary, and the AI line.
// x/y are in the centerline's own metric projection; lat/lng are back-projected.

/**
 * @param {{name:string, cones:Array, cl:object, edges:object, track:object,
 *          generatedAt?:(string|number|null)}} arg
 *   cl    = computeCenterline result with `.metric`
 *   edges = buildRoadEdges result (elevation summary scalars live here)
 *   track = buildTrackModel result (ordered geometry + ai + meta)
 * @returns {object} the enriched, re-importable record
 */
export function buildEnrichedJSON({ name, cones, cl, edges, track, generatedAt = null }) {
  const { lat0, lng0, mlat, mlng, step } = cl.metric;
  const back = (x, y) => [lat0 + y / mlat, lng0 + x / mlng];

  const P = track.P;            // stations in built order (matches ai + mesh)
  const E = track.edges;        // ordered edges (Le/Re/zC/zL/zR/bank/width)
  const N = P.length;

  const points = [];
  for (let i = 0; i < N; i++) {
    const [lat, lng] = back(P[i][0], P[i][1]);
    points.push({
      lat, lng, x: P[i][0], y: P[i][1],
      z: E.zC[i], width: E.width[i], widthL: E.halfLeft[i], widthR: E.halfRight[i], bank: E.bank[i],
    });
  }

  const edgePoint = (p, z) => { const [lat, lng] = back(p[0], p[1]); return { lat, lng, x: p[0], y: p[1], z }; };
  const left = E.Le.map((p, i) => edgePoint(p, E.zL[i]));
  const right = E.Re.map((p, i) => edgePoint(p, E.zR[i]));

  return {
    name,
    cones,                                        // untouched -> re-importable
    export: { tool: "cone2track", pipeline: "native-js", schema: 1, generatedAt },
    projection: { lat0, lng0, mlat, mlng },
    centerline: {
      closed: cl.closed,
      length_m: Math.round(cl.length * 10) / 10,
      step_m: step,
      count: N,
      points,
    },
    edges: { left, right },
    elevation: {
      present: edges.hasElevation,
      relief_m: Math.round(edges.relief * 1000) / 1000,
      smoothingSigma: edges.smoothingSigma,
    },
    ai: {
      speeds: track.aiData.speeds,
      radii: track.aiData.radii,
      grades: track.aiData.grades,
      camber: track.aiData.camber,
    },
    meta: {
      medianWidth_m: track.meta.medianWidth,
      minWidth_m: track.meta.minWidth,
      run: track.meta.run,
      // start line + travel direction, unified: the GPS coords of the computed
      // (midpoint/centerline) start point and whether the loop is reversed.
      start: {
        lat: points[0].lat,
        lng: points[0].lng,
        reverse: !!cl.metric.reverse,
      },
    },
  };
}
