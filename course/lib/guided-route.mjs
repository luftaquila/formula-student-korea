// Marker-constrained course routing for branched/open layouts.
//
// The automatic circuit pipeline in centerline.mjs deliberately reduces a cone
// field to one simple loop. That is the right model for endurance/autocross, but
// it cannot represent a skidpad walk that reuses both circles and has distinct
// entry/exit arms. This module keeps the inferred medial graph intact and routes
// an ordered list of marker visits across it. Repeated marker ids are allowed, so
// one physical marker can constrain multiple laps without duplicate map objects.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function project(cones) {
  const lat0 = cones.reduce((s, c) => s + c.lat, 0) / cones.length;
  const lng0 = cones.reduce((s, c) => s + c.lng, 0) / cones.length;
  const mlat = 110540.0;
  const mlng = 111320.0 * Math.cos((lat0 * Math.PI) / 180);
  const point = ({ lat, lng }) => [(lng - lng0) * mlng, (lat - lat0) * mlat];
  const back = (x, y) => [lat0 + y / mlat, lng0 + x / mlng];
  return { lat0, lng0, mlat, mlng, point, back };
}

function nearestDist(p, pts) {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, dist(p, q));
  return best;
}

// Bowyer-Watson Delaunay triangulation, kept local so the legacy automatic
// centerline implementation remains byte-for-byte untouched.
function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) {
    minx = Math.min(minx, x); miny = Math.min(miny, y);
    maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
  }
  const dmax = Math.max(maxx - minx, maxy - miny) || 1;
  const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
  const V = pts.slice();
  const s0 = V.length; V.push([midx - 20 * dmax, midy - dmax]);
  const s1 = V.length; V.push([midx + 20 * dmax, midy - dmax]);
  const s2 = V.length; V.push([midx, midy + 20 * dmax]);
  const ccw3 = (a, b, c) => {
    const o = (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) -
      (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
    if (Math.abs(o) < 1e-12) return null;
    return o > 0 ? [a, b, c] : [a, c, b];
  };
  const inCircle = (t, p) => {
    const ax = V[t[0]][0] - V[p][0], ay = V[t[0]][1] - V[p][1];
    const bx = V[t[1]][0] - V[p][0], by = V[t[1]][1] - V[p][1];
    const cx = V[t[2]][0] - V[p][0], cy = V[t[2]][1] - V[p][1];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) -
      (bx * bx + by * by) * (ax * cy - cx * ay) +
      (cx * cx + cy * cy) * (ax * by - bx * ay) > 0;
  };
  let tris = [[s0, s1, s2]];
  for (let i = 0; i < n; i++) {
    const bad = [];
    for (let t = 0; t < tris.length; t++) if (inCircle(tris[t], i)) bad.push(t);
    const edges = new Map();
    for (const t of bad) {
      const [a, b, c] = tris[t];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const e = edges.get(key);
        if (e) e.count++;
        else edges.set(key, { u, v, count: 1 });
      }
    }
    for (let j = bad.length - 1; j >= 0; j--) tris.splice(bad[j], 1);
    for (const { u, v, count } of edges.values()) {
      if (count !== 1) continue;
      const tri = ccw3(u, v, i);
      if (tri) tris.push(tri);
    }
  }
  return tris.filter(([a, b, c]) => a < n && b < n && c < n);
}

function buildGraph(cones, frame) {
  const walls = cones.filter((c) => c.side === "left" || c.side === "right");
  const centers = cones.filter((c) => c.side === "center").map(frame.point);
  const left = walls.filter((c) => c.side === "left").map(frame.point);
  const right = walls.filter((c) => c.side === "right").map(frame.point);
  if (left.length < 3 || right.length < 3) throw new Error("주행 경로에는 왼쪽·오른쪽 콘이 각각 3개 이상 필요합니다.");
  const widths = left.map((p) => nearestDist(p, right)).sort((a, b) => a - b);
  const width = widths[Math.floor(widths.length / 2)];
  if (!(width > 0)) throw new Error("콘 배치에서 유효한 코스 폭을 계산할 수 없습니다.");

  const points = walls.map(frame.point);
  const side = walls.map((c) => c.side);
  const tris = delaunay(points);
  const nodesByKey = new Map();
  const adjacency = new Map();
  const edgeMap = new Map();
  const nodeKey = (p) => `${Math.round(p[0] * 2) / 2}_${Math.round(p[1] * 2) / 2}`;
  const crossing = (a, b) => {
    if (side[a] === side[b]) return null;
    const length = dist(points[a], points[b]);
    const mid = [(points[a][0] + points[b][0]) / 2, (points[a][1] + points[b][1]) / 2];
    if (!(length < 2.6 * width ||
      (centers.length && length < 4.5 * width && nearestDist(mid, centers) < width))) return null;
    const leftIndex = side[a] === "left" ? a : b;
    const rightIndex = side[a] === "right" ? a : b;
    const leftAltitude = typeof walls[leftIndex].alt === "number" && Number.isFinite(walls[leftIndex].alt) ? walls[leftIndex].alt : null;
    const rightAltitude = typeof walls[rightIndex].alt === "number" && Number.isFinite(walls[rightIndex].alt) ? walls[rightIndex].alt : null;
    const alts = [leftAltitude, rightAltitude].filter((v) => v != null);
    return {
      point: mid,
      halfWidth: length / 2,
      altitude: alts.length ? alts.reduce((s, v) => s + v, 0) / alts.length : null,
      leftPoint: points[leftIndex].slice(),
      rightPoint: points[rightIndex].slice(),
      leftAltitude,
      rightAltitude,
    };
  };
  const ensureNode = (sample) => {
    const key = nodeKey(sample.point);
    let node = nodesByKey.get(key);
    if (!node) {
      node = {
        id: nodesByKey.size,
        point: sample.point.slice(),
        halfWidths: [], altitudes: [], leftAltitudes: [], rightAltitudes: [], sections: [],
      };
      nodesByKey.set(key, node);
      adjacency.set(node.id, []);
    }
    node.halfWidths.push(sample.halfWidth);
    if (sample.altitude != null) node.altitudes.push(sample.altitude);
    if (sample.leftAltitude != null) node.leftAltitudes.push(sample.leftAltitude);
    if (sample.rightAltitude != null) node.rightAltitudes.push(sample.rightAltitude);
    node.sections.push(sample);
    return node;
  };
  for (const tri of tris) {
    const samples = [];
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const sample = crossing(a, b);
      if (sample) samples.push(sample);
    }
    if (samples.length !== 2) continue;
    const a = ensureNode(samples[0]), b = ensureNode(samples[1]);
    if (a.id === b.id) continue;
    const ek = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`;
    if (edgeMap.has(ek)) continue;
    const edge = { id: edgeMap.size, a: a.id, b: b.id, length: dist(a.point, b.point) };
    edgeMap.set(ek, edge);
    adjacency.get(a.id).push({ node: b.id, edge: edge.id, length: edge.length });
    adjacency.get(b.id).push({ node: a.id, edge: edge.id, length: edge.length });
  }
  const nodes = [...nodesByKey.values()];
  const median = (values, fallback) => {
    if (!values.length) return fallback;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  for (const node of nodes) {
    // Long diagonal Delaunay crossings occur at a wide opening/junction. They
    // are useful connectivity samples but must not turn one junction node into
    // an oversized circular asphalt blob. Retain local variation up to 20%
    // above the robust course width; the AC builder adds its separate 1 m
    // driveability shoulder later.
    node.halfWidth = Math.min(median(node.halfWidths, width / 2), width * 0.6);
    node.altitude = median(node.altitudes, null);
    node.leftAltitude = median(node.leftAltitudes, null);
    node.rightAltitude = median(node.rightAltitudes, null);
    const section = node.sections.slice().sort((a, b) => a.halfWidth - b.halfWidth)[Math.floor(node.sections.length / 2)];
    node.leftPoint = section.leftPoint.slice();
    node.rightPoint = section.rightPoint.slice();
    delete node.halfWidths;
    delete node.altitudes;
    delete node.leftAltitudes;
    delete node.rightAltitudes;
    delete node.sections;
  }
  if (!nodes.length || !edgeMap.size) throw new Error("콘 사이에서 연결된 주행 통로를 찾을 수 없습니다.");
  return { nodes, edges: [...edgeMap.values()], adjacency, width };
}

// Recover the shared straight through a skidpad from cone pairs straddling the
// entry→exit marker axis. This is intentionally marker-constrained: it adds no
// speculative branches elsewhere and can join same-colour walls at the waist
// without changing the ordinary side-based circle arcs.
function augmentAxisCorridor(graph, cones, frame, startMarker, endMarker) {
  const start = frame.point(startMarker), end = frame.point(endMarker);
  const axisLength = dist(start, end);
  if (axisLength < graph.width * 2) return false;
  const tangent = [(end[0] - start[0]) / axisLength, (end[1] - start[1]) / axisLength];
  const normal = [-tangent[1], tangent[0]];
  const walls = cones
    .filter((cone) => cone.side === "left" || cone.side === "right")
    .map((cone, index) => {
      const point = frame.point(cone);
      const rel = [point[0] - start[0], point[1] - start[1]];
      return {
        cone, index, point,
        along: rel[0] * tangent[0] + rel[1] * tangent[1],
        lateral: rel[0] * normal[0] + rel[1] * normal[1],
      };
    })
    .filter((sample) => sample.along >= -graph.width && sample.along <= axisLength + graph.width &&
      Math.abs(sample.lateral) <= graph.width * 1.25);
  const negative = walls.filter((sample) => sample.lateral < 0);
  const positive = walls.filter((sample) => sample.lateral > 0);
  const candidates = [];
  for (const a of negative) for (const b of positive) {
    const alongGap = Math.abs(a.along - b.along);
    const across = Math.abs(a.lateral - b.lateral);
    const midpointOffset = Math.abs((a.lateral + b.lateral) / 2);
    if (alongGap > graph.width || across < graph.width * 0.45 || across > graph.width * 2.1 ||
        midpointOffset > graph.width * 0.45) continue;
    candidates.push({
      a, b,
      score: alongGap * 2 + Math.abs(across - graph.width) + midpointOffset,
    });
  }
  candidates.sort((a, b) => a.score - b.score || a.a.along - b.a.along || a.a.index - b.a.index || a.b.index - b.b.index);
  const used = new Set(), pairs = [];
  for (const candidate of candidates) {
    if (used.has(candidate.a.index) || used.has(candidate.b.index)) continue;
    used.add(candidate.a.index); used.add(candidate.b.index);
    const point = [
      (candidate.a.point[0] + candidate.b.point[0]) / 2,
      (candidate.a.point[1] + candidate.b.point[1]) / 2,
    ];
    pairs.push({
      ...candidate,
      point,
      along: (candidate.a.along + candidate.b.along) / 2,
      halfWidth: Math.min(dist(candidate.a.point, candidate.b.point) / 2, graph.width * 0.7),
    });
  }
  pairs.sort((a, b) => a.along - b.along || a.score - b.score);
  const corridor = [];
  for (const pair of pairs) {
    const previous = corridor[corridor.length - 1];
    if (previous && Math.abs(pair.along - previous.along) < graph.width * 0.3) {
      if (pair.score < previous.score) corridor[corridor.length - 1] = pair;
      continue;
    }
    corridor.push(pair);
  }
  if (corridor.length < 4 || corridor[0].along > graph.width ||
      corridor[corridor.length - 1].along < axisLength - graph.width) return false;
  for (let i = 1; i < corridor.length; i++) {
    if (dist(corridor[i - 1].point, corridor[i].point) > graph.width * 2.2) return false;
  }

  const baseNodes = graph.nodes.slice();
  const nearbyBase = corridor.map((pair) => baseNodes
    .map((node) => ({ node: node.id, distance: dist(pair.point, node.point) }))
    .filter((candidate) => candidate.distance <= graph.width * 1.25)
    .sort((a, b) => a.distance - b.distance || a.node - b.node)
    .slice(0, 2));
  const connectedStations = nearbyBase
    .map((connections, index) => connections.length ? corridor[index].along : null)
    .filter((value) => value != null);
  if (connectedStations.length < 2 || Math.max(...connectedStations) - Math.min(...connectedStations) < graph.width * 2) return false;

  const existingEdges = new Set(graph.edges.map((edge) => edge.a < edge.b ? `${edge.a}_${edge.b}` : `${edge.b}_${edge.a}`));
  const addEdge = (a, b, axisCorridor = false) => {
    if (a === b) return;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (existingEdges.has(key)) return;
    const length = dist(graph.nodes[a].point, graph.nodes[b].point);
    const edge = { id: graph.edges.length, a, b, length, ...(axisCorridor ? { axisCorridor: true } : {}) };
    graph.edges.push(edge); existingEdges.add(key);
    graph.adjacency.get(a).push({ node: b, edge: edge.id, length });
    graph.adjacency.get(b).push({ node: a, edge: edge.id, length });
  };
  const corridorIds = corridor.map((pair) => {
    const altitudeA = typeof pair.a.cone.alt === "number" && Number.isFinite(pair.a.cone.alt) ? pair.a.cone.alt : null;
    const altitudeB = typeof pair.b.cone.alt === "number" && Number.isFinite(pair.b.cone.alt) ? pair.b.cone.alt : null;
    const altitudes = [altitudeA, altitudeB].filter((value) => value != null);
    const node = {
      id: graph.nodes.length,
      point: pair.point,
      halfWidth: pair.halfWidth,
      altitude: altitudes.length ? altitudes.reduce((sum, value) => sum + value, 0) / altitudes.length : null,
      leftPoint: pair.a.point.slice(), rightPoint: pair.b.point.slice(),
      leftAltitude: altitudeA, rightAltitude: altitudeB,
    };
    graph.nodes.push(node); graph.adjacency.set(node.id, []);
    return node.id;
  });
  for (let i = 1; i < corridorIds.length; i++) {
    addEdge(corridorIds[i - 1], corridorIds[i], true);
  }
  nearbyBase.forEach((connections, index) => {
    for (const connection of connections) addEdge(corridorIds[index], connection.node, true);
  });
  return true;
}

function snapMarker(marker, graph, frame, terminal = false) {
  const p = frame.point(marker);
  let best = null;
  for (const node of graph.nodes) {
    const d = dist(p, node.point);
    // Interior direction markers should not land on tiny Delaunay spurs merely
    // because a degree-1 sample is centimetres closer. Entry/exit markers may
    // intentionally target a terminal arm, so they retain pure nearest snap.
    const endpointPenalty = !terminal && (graph.adjacency.get(node.id)?.length || 0) < 2 ? graph.width * 1.5 : 0;
    const score = d + endpointPenalty;
    if (!best || score < best.score || (score === best.score && node.id < best.node)) {
      best = { node: node.id, distance: d, score };
    }
  }
  if (!best || best.distance > Math.max(5, graph.width * 2.5)) {
    throw new Error(`주행 마커 "${marker.label || marker.id}"가 콘 통로에서 너무 멉니다 (${best?.distance.toFixed(1) || "?"} m).`);
  }
  return best.node;
}

function graphComponents(graph) {
  const component = new Array(graph.nodes.length).fill(-1);
  let count = 0;
  for (const node of graph.nodes) {
    if (component[node.id] !== -1) continue;
    const stack = [node.id];
    component[node.id] = count;
    while (stack.length) {
      const current = stack.pop();
      for (const edge of graph.adjacency.get(current) || []) {
        if (component[edge.node] !== -1) continue;
        component[edge.node] = count;
        stack.push(edge.node);
      }
    }
    count++;
  }
  return component;
}

// Cone openings at a skidpad waist can leave two medial-axis fragments a few
// metres apart: the Delaunay cells on either side of the opening do not share a
// cross-wall edge even though the pavement is continuous. Only the components
// explicitly required by consecutive route markers are bridged, and only via
// nearby graph endpoints. Automatic (marker-free) courses never call this.
function bridgeMarkerComponents(graph, snapped) {
  const maxGap = Math.max(4, graph.width * 2.5);
  for (let visit = 1; visit < snapped.length; visit++) {
    let components = graphComponents(graph);
    if (components[snapped[visit - 1]] === components[snapped[visit]]) continue;
    const fromComponent = components[snapped[visit - 1]];
    const toComponent = components[snapped[visit]];
    const candidatesFor = (maxDegree) => {
      const candidates = [];
      for (const a of graph.nodes) {
        if (components[a.id] !== fromComponent || (graph.adjacency.get(a.id)?.length || 0) > maxDegree) continue;
        for (const b of graph.nodes) {
          if (components[b.id] !== toComponent || (graph.adjacency.get(b.id)?.length || 0) > maxDegree) continue;
          candidates.push({ a: a.id, b: b.id, length: dist(a.point, b.point) });
        }
      }
      return candidates.sort((a, b) => a.length - b.length || a.a - b.a || a.b - b.b);
    };
    // True graph endpoints identify the two sides of a shared opening. Fall
    // back to degree-2 nodes only for coarse/sparse surveyed fields.
    let candidates = candidatesFor(1);
    if (!candidates.length || candidates[0].length > maxGap) candidates = candidatesFor(2);
    const best = candidates[0];
    if (!best || best.length > maxGap) {
      const gap = best ? ` (가장 가까운 간격 ${best.length.toFixed(1)} m, 허용 ${maxGap.toFixed(1)} m)` : "";
      throw new Error(`${visit}→${visit + 1}단계의 콘 통로가 분리되어 있습니다${gap}. 허리·분기점 가까이에 중간 마커를 추가하거나 콘 개구부를 확인하세요.`);
    }
    const bridges = [best];
    // Two open arcs meeting at a skidpad waist need both sides joined, otherwise
    // the second circle becomes a dead-end lollipop and a full lap cannot return
    // without a U-turn. Add a second short, endpoint-disjoint bridge when present.
    const second = candidates.find((candidate) =>
      candidate.length <= maxGap && candidate.a !== best.a && candidate.b !== best.b
    );
    if (second) bridges.push(second);
    for (const bridge of bridges) {
      const edge = { id: graph.edges.length, a: bridge.a, b: bridge.b, length: bridge.length, guidedBridge: true };
      graph.edges.push(edge);
      graph.adjacency.get(bridge.a).push({ node: bridge.b, edge: edge.id, length: edge.length });
      graph.adjacency.get(bridge.b).push({ node: bridge.a, edge: edge.id, length: edge.length });
    }
  }
}

// Direction-aware shortest path. State includes the previous node so the first
// move of a new marker leg cannot immediately reverse the last completed leg.
function shortestPath(graph, start, target, previous) {
  if (start === target) throw new Error("연속한 주행 단계가 같은 그래프 지점입니다. 원 둘레에 중간 마커를 추가하세요.");
  const states = new Map();
  const done = new Set();
  const queue = [];
  const key = (prev, cur) => `${prev ?? "x"}:${cur}`;
  const push = (state) => {
    const k = key(state.prev, state.cur);
    if (state.cost >= (states.get(k)?.cost ?? Infinity)) return;
    states.set(k, state);
    queue.push(state);
  };
  push({ prev: previous ?? null, cur: start, cost: 0, parent: null, edge: null });
  let finish = null;
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.cur - b.cur || (a.prev ?? -1) - (b.prev ?? -1));
    const state = queue.shift();
    const sk = key(state.prev, state.cur);
    if (done.has(sk) || states.get(sk) !== state) continue;
    done.add(sk);
    if (state.cur === target) { finish = state; break; }
    const curPoint = graph.nodes[state.cur].point;
    for (const next of graph.adjacency.get(state.cur) || []) {
      if (next.node === state.prev) continue; // no immediate U-turn
      let turnCost = 0;
      if (state.prev != null) {
        const prevPoint = graph.nodes[state.prev].point;
        const nextPoint = graph.nodes[next.node].point;
        const ux = curPoint[0] - prevPoint[0], uy = curPoint[1] - prevPoint[1];
        const vx = nextPoint[0] - curPoint[0], vy = nextPoint[1] - curPoint[1];
        const um = Math.hypot(ux, uy) || 1, vm = Math.hypot(vx, vy) || 1;
        const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (um * vm)));
        turnCost = graph.width * 0.35 * (1 - cosine);
      }
      push({
        prev: state.cur,
        cur: next.node,
        cost: state.cost + next.length + turnCost,
        parent: state,
        edge: next.edge,
      });
    }
  }
  if (!finish) throw new Error("주행 마커 사이의 연속 경로를 찾지 못했습니다. 진행 방향을 나타내는 중간 마커를 추가하세요.");
  const nodes = [], edges = [];
  for (let s = finish; s; s = s.parent) {
    nodes.push(s.cur);
    if (s.edge != null) edges.push(s.edge);
  }
  nodes.reverse(); edges.reverse();
  return { nodes, edges };
}

function resampleRoute(graph, nodeIds, step) {
  const out = [];
  let length = 0;
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const a = graph.nodes[nodeIds[i]], b = graph.nodes[nodeIds[i + 1]];
    const segment = dist(a.point, b.point);
    if (segment < 1e-9) continue;
    const count = Math.max(1, Math.ceil(segment / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      out.push({
        x: a.point[0] + t * (b.point[0] - a.point[0]),
        y: a.point[1] + t * (b.point[1] - a.point[1]),
        halfWidth: a.halfWidth + t * (b.halfWidth - a.halfWidth),
        altitude: a.altitude != null && b.altitude != null ? a.altitude + t * (b.altitude - a.altitude) : (a.altitude ?? b.altitude),
      });
    }
    length += segment;
  }
  const last = graph.nodes[nodeIds[nodeIds.length - 1]];
  out.push({ x: last.point[0], y: last.point[1], halfWidth: last.halfWidth, altitude: last.altitude });
  return { points: out, length };
}

function smoothRoute(points, passes = 4) {
  let current = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((point) => ({ ...point }));
    for (let i = 1; i < current.length - 1; i++) {
      const a = current[i - 1], b = current[i], c = current[i + 1];
      next[i].x = 0.25 * a.x + 0.5 * b.x + 0.25 * c.x;
      next[i].y = 0.25 * a.y + 0.5 * b.y + 0.25 * c.y;
      next[i].halfWidth = 0.25 * a.halfWidth + 0.5 * b.halfWidth + 0.25 * c.halfWidth;
      if (a.altitude != null && b.altitude != null && c.altitude != null) {
        next[i].altitude = 0.25 * a.altitude + 0.5 * b.altitude + 0.25 * c.altitude;
      }
    }
    current = next;
  }
  let length = 0;
  for (let i = 1; i < current.length; i++) length += dist([current[i - 1].x, current[i - 1].y], [current[i].x, current[i].y]);
  return { points: current, length };
}

/**
 * Build an ordered, possibly open/repeating route from physical markers.
 * @param {Array} cones
 * @param {Array<{id:number,lat:number,lng:number,label?:string}>} markers
 * @param {Array<number>} steps ordered marker ids; ids may repeat
 * @param {{step?:number}} opts
 */
export function computeGuidedRoute(cones, markers, steps, opts = {}) {
  if (!Array.isArray(cones) || cones.length < 6) throw new Error("주행 경로를 만들 콘이 부족합니다.");
  if (!Array.isArray(markers) || !Array.isArray(steps) || steps.length < 2) {
    throw new Error("주행 순서에는 시작과 종료를 포함해 2개 이상의 단계가 필요합니다.");
  }
  const byId = new Map(markers.map((m) => [m.id, m]));
  const ordered = steps.map((id) => {
    const marker = byId.get(id);
    if (!marker) throw new Error(`주행 순서가 존재하지 않는 마커 #${id}를 참조합니다.`);
    return marker;
  });
  const frame = project(cones);
  const sideGraph = buildGraph(cones, frame);
  // A connected all-degree-2 graph can only describe one loop. That is valid
  // for a circuit, but a skidpad has distinct entry/exit arms outside that
  // collapsed loop. In that specific topology, recover only the shared axis
  // corridor from geometric cone pairs; arbitrary open routes whose terminal
  // markers already lie on the loop stay on the ordinary side graph.
  // Marker-free endurance/autocross never enters this module at all.
  const openGuidedRoute = steps[0] !== steps[steps.length - 1];
  const collapsedToSingleLoop = new Set(graphComponents(sideGraph)).size === 1 &&
    sideGraph.nodes.every((node) => (sideGraph.adjacency.get(node.id)?.length || 0) === 2);
  const terminalOutsideLoop = [ordered[0], ordered[ordered.length - 1]].some((marker) => {
    const point = frame.point(marker);
    return Math.min(...sideGraph.nodes.map((node) => dist(point, node.point))) > sideGraph.width * 1.25;
  });
  const graph = sideGraph;
  if (openGuidedRoute && collapsedToSingleLoop && terminalOutsideLoop &&
      !augmentAxisCorridor(graph, cones, frame, ordered[0], ordered[ordered.length - 1])) {
    throw new Error("진입·진출 마커 축에서 연속된 중앙 통로를 찾지 못했습니다. 양쪽 팔 끝에 마커를 두고 중앙 통로의 콘 쌍을 확인하세요.");
  }
  const interiorMarkerIds = new Set(steps.slice(1, -1));
  const snappedByMarker = new Map();
  const snapped = ordered.map((marker, index) => {
    if (!snappedByMarker.has(marker.id)) {
      const terminalOnly = !interiorMarkerIds.has(marker.id) && (index === 0 || index === ordered.length - 1);
      snappedByMarker.set(marker.id, snapMarker(marker, graph, frame, terminalOnly));
    }
    return snappedByMarker.get(marker.id);
  });
  bridgeMarkerComponents(graph, snapped);
  const nodeIds = [snapped[0]], edgeIds = [];
  let previous = null;
  for (let i = 1; i < snapped.length; i++) {
    let leg;
    try {
      leg = shortestPath(graph, snapped[i - 1], snapped[i], previous);
    } catch (err) {
      const from = ordered[i - 1].label || ordered[i - 1].id;
      const to = ordered[i].label || ordered[i].id;
      throw new Error(`${i}→${i + 1}단계 (${from} → ${to}): ${err.message}`);
    }
    edgeIds.push(...leg.edges);
    nodeIds.push(...leg.nodes.slice(1));
    previous = nodeIds.length >= 2 ? nodeIds[nodeIds.length - 2] : null;
  }
  // The graph is deliberately topological and can contain a sharp vertex where
  // two Delaunay fragments are bridged at a junction. Light local smoothing
  // turns that into a human-drivable guide while the physical surface continues
  // to come from the exact unique graph-edge union.
  const sampled = smoothRoute(resampleRoute(graph, nodeIds, Math.max(0.25, opts.step ?? 1)).points);
  const altitudes = sampled.points.map((p) => p.altitude).filter((v) => typeof v === "number" && Number.isFinite(v));
  const altitudeOffset = altitudes.length ? Math.min(...altitudes) : 0;
  const points = sampled.points.map((p) => {
    const [lat, lng] = frame.back(p.x, p.y);
    return { lat, lng, width: 2 * p.halfWidth, z: p.altitude == null ? 0 : p.altitude - altitudeOffset };
  });
  return {
    ok: true,
    closed: nodeIds[0] === nodeIds[nodeIds.length - 1],
    length: sampled.length,
    points,
    metric: {
      ...frame,
      point: undefined,
      back: undefined,
      step: opts.step ?? 1,
      width: graph.width,
      P: sampled.points.map((p) => [p.x, p.y]),
      z: sampled.points.map((p) => p.altitude == null ? 0 : p.altitude - altitudeOffset),
      halfWidth: sampled.points.map((p) => p.halfWidth),
      graph,
      routeNodeIds: nodeIds,
      routeEdgeIds: edgeIds,
      usedEdgeIds: [...new Set(edgeIds)],
      altitudeOffset,
      markers,
      steps: steps.slice(),
      left: cones.filter((c) => c.side === "left").map((c) => [...frame.point(c), c.alt ?? null]),
      right: cones.filter((c) => c.side === "right").map((c) => [...frame.point(c), c.alt ?? null]),
      centers: cones.filter((c) => c.side === "center").map((c) => [...frame.point(c), c.alt ?? null]),
    },
  };
}
