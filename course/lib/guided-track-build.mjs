// Assetto Corsa model builder for marker-guided, branched/open routes.
// Physical pavement is generated from the UNIQUE graph edges used by the route;
// the ordered route may traverse those edges repeatedly without stacking
// coplanar collision meshes. The legacy circuit builder remains unchanged.

import { writeKn5, meshNode, dummyNode, translationMatrix, acVec, IDENTITY } from "./kn5.mjs";
import { writeFastLane } from "./ai-line.mjs";
import { asphaltDDS, grassDDS, coneDDS } from "./dds.mjs";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);

function closestEdgeSample(metric, x, y) {
  const graph = metric.graph;
  let best = null;
  for (const edgeId of metric.usedEdgeIds) {
    const edge = graph.edges[edgeId];
    const a = graph.nodes[edge.a], b = graph.nodes[edge.b];
    const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
    const den = dx * dx + dy * dy;
    const t = den > 1e-12 ? Math.max(0, Math.min(1, ((x - a.point[0]) * dx + (y - a.point[1]) * dy) / den)) : 0;
    const px = a.point[0] + t * dx, py = a.point[1] + t * dy;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (!best || d2 < best.d2) {
      let altitude = a.altitude != null && b.altitude != null
        ? a.altitude + t * (b.altitude - a.altitude)
        : (a.altitude ?? b.altitude ?? metric.altitudeOffset);
      const lerpPoint = (pa, pb) => [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
      const lerpNullable = (va, vb) => va != null && vb != null ? va + t * (vb - va) : (va ?? vb);
      const leftPoint = lerpPoint(a.leftPoint, b.leftPoint);
      const rightPoint = lerpPoint(a.rightPoint, b.rightPoint);
      const leftAltitude = lerpNullable(a.leftAltitude, b.leftAltitude);
      const rightAltitude = lerpNullable(a.rightAltitude, b.rightAltitude);
      if (leftAltitude != null && rightAltitude != null) {
        const wx = rightPoint[0] - leftPoint[0], wy = rightPoint[1] - leftPoint[1];
        const wallLength2 = wx * wx + wy * wy;
        // `altitude` already carries longitudinal grade at the closest
        // centerline point (px,py). Add only the lateral component measured by
        // the opposing cones; using x-leftPoint directly would double-count
        // grade where a junction's cross section is not perfectly orthogonal.
        const lateralFromCenter = wallLength2 > 1e-9
          ? Math.max(-1, Math.min(1, ((x - px) * wx + (y - py) * wy) / wallLength2))
          : 0;
        altitude += lateralFromCenter * (rightAltitude - leftAltitude);
      } else if (leftAltitude != null || rightAltitude != null) {
        altitude = leftAltitude ?? rightAltitude;
      }
      best = {
        d2,
        halfWidth: a.halfWidth + t * (b.halfWidth - a.halfWidth) + 1,
        z: altitude - metric.altitudeOffset,
      };
    }
  }
  return best || { d2: Infinity, halfWidth: metric.width / 2 + 1, z: 0 };
}

function usedBounds(metric, margin = 0) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, maxHalf = metric.width / 2 + 1;
  for (const edgeId of metric.usedEdgeIds) {
    const edge = metric.graph.edges[edgeId];
    for (const id of [edge.a, edge.b]) {
      const n = metric.graph.nodes[id];
      minx = Math.min(minx, n.point[0]); miny = Math.min(miny, n.point[1]);
      maxx = Math.max(maxx, n.point[0]); maxy = Math.max(maxy, n.point[1]);
      maxHalf = Math.max(maxHalf, n.halfWidth + 1);
    }
  }
  const pad = maxHalf + margin;
  return { minx: minx - pad, miny: miny - pad, maxx: maxx + pad, maxy: maxy + pad };
}

function surfaceNormal(metric, x, y, delta) {
  const zl = closestEdgeSample(metric, x - delta, y).z;
  const zr = closestEdgeSample(metric, x + delta, y).z;
  const zb = closestEdgeSample(metric, x, y - delta).z;
  const zt = closestEdgeSample(metric, x, y + delta).z;
  const world = [-(zr - zl) / (2 * delta), -(zt - zb) / (2 * delta), 1];
  const m = norm3(world) || 1;
  return [world[0] / m, world[2] / m, -world[1] / m];
}

// Rasterise the union of edge capsules into one indexed height-field. A cell is
// road when its centre is within the interpolated corridor half-width. Shared
// grid vertices ensure junctions have one collision surface and no z-fighting.
function buildRoadSurface(metric, { cellSize = 0.5, maxVertices = 62000 } = {}) {
  const bounds = usedBounds(metric, 1);
  const spanX = bounds.maxx - bounds.minx, spanY = bounds.maxy - bounds.miny;
  let cell = Math.max(0.25, cellSize);
  let nx = Math.max(1, Math.ceil(spanX / cell)), ny = Math.max(1, Math.ceil(spanY / cell));
  // Worst case every grid point is used. Coarsen deterministically before mesh creation.
  while ((nx + 1) * (ny + 1) > maxVertices) {
    cell *= 1.05;
    nx = Math.max(1, Math.ceil(spanX / cell)); ny = Math.max(1, Math.ceil(spanY / cell));
  }
  const dx = spanX / nx, dy = spanY / ny;
  const vertexMap = new Map(), positions = [], normals = [], uvs = [], indices = [];
  const vertex = (ix, iy) => {
    const key = iy * (nx + 1) + ix;
    if (vertexMap.has(key)) return vertexMap.get(key);
    const x = bounds.minx + ix * dx, y = bounds.miny + iy * dy;
    const z = closestEdgeSample(metric, x, y).z;
    const id = positions.length;
    positions.push([x, z, -y]);
    normals.push(surfaceNormal(metric, x, y, Math.max(dx, dy)));
    uvs.push([x / 4, y / 4]);
    vertexMap.set(key, id);
    return id;
  };
  for (let iy = 0; iy < ny; iy++) {
    const y = bounds.miny + (iy + 0.5) * dy;
    for (let ix = 0; ix < nx; ix++) {
      const x = bounds.minx + (ix + 0.5) * dx;
      const sample = closestEdgeSample(metric, x, y);
      // Include a half-cell fringe so the raster never cuts inside the surveyed lane.
      if (Math.sqrt(sample.d2) > sample.halfWidth + Math.hypot(dx, dy) / 2) continue;
      const a = vertex(ix, iy), b = vertex(ix + 1, iy), c = vertex(ix, iy + 1), d = vertex(ix + 1, iy + 1);
      indices.push(a, b, d, a, d, c);
    }
  }
  if (!indices.length) throw new Error("주행 마커 경로에서 도로 메시를 만들 수 없습니다.");
  return { positions, normals, uvs, indices, bounds, cellSize: cell };
}

function buildGround(metric, roadBounds, { margin = 50, cellSize = 3, maxVertices = 62000 } = {}) {
  const x0 = roadBounds.minx - margin, x1 = roadBounds.maxx + margin;
  const y0 = roadBounds.miny - margin, y1 = roadBounds.maxy + margin;
  const spanX = x1 - x0, spanY = y1 - y0;
  let cell = Math.max(1, cellSize);
  let nx = Math.max(1, Math.ceil(spanX / cell)), ny = Math.max(1, Math.ceil(spanY / cell));
  while ((nx + 1) * (ny + 1) > maxVertices) {
    cell *= 1.05;
    nx = Math.max(1, Math.ceil(spanX / cell)); ny = Math.max(1, Math.ceil(spanY / cell));
  }
  const dx = spanX / nx, dy = spanY / ny;
  const positions = [], normals = [], uvs = [], indices = [];
  for (let iy = 0; iy <= ny; iy++) {
    const y = y0 + iy * dy;
    for (let ix = 0; ix <= nx; ix++) {
      const x = x0 + ix * dx;
      const z = closestEdgeSample(metric, x, y).z - 0.05;
      positions.push([x, z, -y]);
      normals.push(surfaceNormal(metric, x, y, Math.max(dx, dy)));
      uvs.push([x / 6, y / 6]);
    }
  }
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const a = iy * (nx + 1) + ix, b = a + 1, c = a + nx + 1, d = c + 1;
    indices.push(a, b, d, a, d, c);
  }
  return { positions, normals, uvs, indices };
}

function buildCones(cones, metric, { height = 0.30, radius = 0.12, segs = 8 } = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (const cone of cones) {
    const [cx, cy] = metricFramePoint(metric, cone);
    // Preserve each surveyed cone's own MSL altitude. The road uses averaged
    // opposite-wall samples, but substituting that average here would visibly
    // flatten cones on a bank or grade relative to their RTK fixes.
    const z0 = typeof cone.alt === "number" && Number.isFinite(cone.alt)
      ? cone.alt - metric.altitudeOffset
      : closestEdgeSample(metric, cx, cy).z;
    const base = positions.length;
    positions.push([cx, z0 + height, -cy]); normals.push([0, 1, 0]); uvs.push([0.5, 1]);
    for (let i = 0; i < segs; i++) {
      const angle = 2 * Math.PI * i / segs, ce = Math.cos(angle), se = Math.sin(angle);
      positions.push([cx + radius * ce, z0, -(cy + radius * se)]);
      const n = [ce, 0.4, -se], m = norm3(n) || 1;
      normals.push(n.map((v) => v / m)); uvs.push([i / segs, 0]);
    }
    for (let i = 0; i < segs; i++) indices.push(base, base + 1 + i, base + 1 + ((i + 1) % segs));
  }
  return { positions, normals, uvs, indices };
}

function metricFramePoint(metric, { lat, lng }) {
  return [(lng - metric.lng0) * metric.mlng, (lat - metric.lat0) * metric.mlat];
}

function spawnMatrix(point, tangent) {
  const pos = [point[0], point[2], -point[1]];
  let f = [tangent[0], tangent[2] || 0, -tangent[1]];
  const fm = norm3(f) || 1; f = f.map((v) => v / fm);
  let right = [f[2], 0, -f[0]];
  const rm = norm3(right) || 1; right = right.map((v) => v / rm);
  const up = [f[1] * right[2], f[2] * right[0] - f[0] * right[2], -f[1] * right[0]];
  return [
    [right[0], up[0], f[0], pos[0]],
    [right[1], up[1], f[1], pos[1]],
    [right[2], up[2], f[2], pos[2]],
    [0, 0, 0, 1],
  ];
}

function mat(name, texture, diffuse, ambient, specular) {
  return {
    name, shader: "ksPerPixel",
    props: [
      ["ksDiffuse", diffuse, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
      ["ksAmbient", ambient, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
      ["ksSpecular", specular, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
    ],
    textures: [["txDiffuse", texture]],
  };
}

function buildAi(route) {
  const P = route.metric.P, z = route.metric.z, halfWidth = route.metric.halfWidth;
  const n = P.length, positions = P.map((p, i) => [p[0], z[i], -p[1]]);
  const forwards = [], normals = [], radii = [], speeds = [], grades = [];
  for (let i = 0; i < n; i++) {
    const pi = i === 0 ? 0 : i - 1, ni = i === n - 1 ? n - 1 : i + 1;
    let v = [positions[ni][0] - positions[pi][0], positions[ni][1] - positions[pi][1], positions[ni][2] - positions[pi][2]];
    const vm = norm3(v) || 1; v = v.map((x) => x / vm); forwards.push(v);
    normals.push([0, 1, 0]);
    const a = P[pi], b = P[i], c = P[ni];
    const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
    const area = 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    const radius = Math.max(5, Math.min(1000, area > 1e-6 ? ab * bc * ca / (4 * area) : 1000));
    radii.push(radius); speeds.push(Math.max(8, Math.min(30, Math.sqrt(8 * radius))));
    grades.push((z[ni] - z[pi]) / (dist(P[ni], P[pi]) || 1));
  }
  const side = halfWidth.map((v) => v + 1);
  return {
    bytes: writeFastLane({ positions, forwards, normals, sideLeft: side, sideRight: side, speeds, radii, grades, camber: new Array(n).fill(0) }),
    data: { speeds, radii, grades, camber: new Array(n).fill(0) },
  };
}

/** Build KN5 + support AI data for a computeGuidedRoute result. */
export function buildGuidedTrackModel(route, cones, opts = {}) {
  if (!route?.metric?.usedEdgeIds?.length) throw new Error("주행 경로가 도로 구간을 포함하지 않습니다.");
  const name = opts.name || "course";
  const roadMesh = buildRoadSurface(route.metric);
  const groundMesh = buildGround(route.metric, roadMesh.bounds);
  const road = meshNode("1ROAD", roadMesh.positions, roadMesh.normals, roadMesh.uvs, roadMesh.indices, 0);
  const grass = meshNode("1GRASS", groundMesh.positions, groundMesh.normals, groundMesh.uvs, groundMesh.indices, 1);
  const groups = [
    { tag: "L", side: "left", rgb: [240, 205, 15] },
    { tag: "R", side: "right", rgb: [30, 90, 235] },
    { tag: "C", side: "center", rgb: [225, 35, 30] },
  ].map((g) => ({ ...g, cones: cones.filter((c) => c.side === g.side) })).filter((g) => g.cones.length);
  const coneNodes = groups.map((g, i) => {
    const mesh = buildCones(g.cones, route.metric);
    return meshNode(`CONE_${g.tag}`, mesh.positions, mesh.normals, mesh.uvs, mesh.indices, 2 + i);
  });

  const P = route.metric.P, z = route.metric.z;
  const start = [P[0][0], P[0][1], z[0]];
  const startTan = [P[1][0] - P[0][0], P[1][1] - P[0][1], z[1] - z[0]];
  const last = P.length - 1;
  let tx = P[last][0] - P[last - 1][0], ty = P[last][1] - P[last - 1][1];
  const tm = Math.hypot(tx, ty) || 1; tx /= tm; ty /= tm;
  const hw = route.metric.halfWidth[last] + 1;
  const leftFinish = [P[last][0] - ty * hw, P[last][1] + tx * hw, z[last]];
  const rightFinish = [P[last][0] + ty * hw, P[last][1] - tx * hw, z[last]];
  const root = dummyNode(name, IDENTITY, [
    road, grass, ...coneNodes,
    dummyNode("AC_PIT_0", spawnMatrix(start, startTan)),
    dummyNode("AC_START_0", spawnMatrix(start, startTan)),
    dummyNode("AC_TIME_0_L", translationMatrix(acVec(leftFinish))),
    dummyNode("AC_TIME_0_R", translationMatrix(acVec(rightFinish))),
  ]);
  const textures = [["asphalt.dds", asphaltDDS()], ["grass.dds", grassDDS()]];
  const materials = [mat("road", "asphalt.dds", 0.6, 0.5, 0.2), mat("grass", "grass.dds", 0.5, 0.4, 0)];
  for (const group of groups) {
    const texture = `cone_${group.tag}.dds`;
    textures.push([texture, coneDDS(group.rgb)]);
    materials.push(mat(`cone_${group.tag}`, texture, 0.85, 0.75, 0.05));
  }
  const ai = buildAi(route);
  return {
    kn5: writeKn5({ textures, materials, root }),
    ai: ai.bytes,
    aiData: ai.data,
    meta: {
      name,
      length: route.length,
      medianWidth: route.metric.width + 2,
      minWidth: Math.min(...route.metric.halfWidth) * 2 + 2,
      run: "guided",
      reverse: false,
      guided: true,
    },
    mapGeometry: { positions: roadMesh.positions, indices: roadMesh.indices },
    surface: { vertices: roadMesh.positions.length, triangles: roadMesh.indices.length / 3, cellSize: roadMesh.cellSize },
  };
}
